// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The runs each batch-five audio operation makes (inner#1305 §6, §7.1):
 * single runs, a measure-then-run pair for loudness, and pipes through sox
 * for reverb and pitch, all ending in an AAC .m4a.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { buildCompressorFilter, buildEqFilter, defaultDynamicsValue } from "@breatic/shared";

import {
  inputRefusal,
  opSteps,
  outputFileName,
  outputRefusal,
  readLoudnormMeasure,
  type RunStep,
} from "@ingest/jobs/op-args.js";
import type { ProbeReport } from "@ingest/media-metadata.js";

const IN = "/tmp/job/source";
const OUT = "/tmp/job/out.m4a";
const WORK = "/tmp/job";
const FIXTURES = join(__dirname, "fixtures");
const AAC_OUT = ["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", OUT];

/** A probe of one audio stream. */
function audioProbe(sampleRate: number | undefined = 44100, channels = 2): ProbeReport {
  return {
    streams: [
      {
        index: 0,
        codecType: "audio",
        codecName: "aac",
        width: null,
        height: null,
        attachedPic: false,
        ...(sampleRate === undefined ? {} : { sampleRate }),
        channels,
      },
    ],
    durationSeconds: 12,
  };
}

/**
 * The value after a flag.
 * @param args - The arguments.
 * @param flag - The flag.
 * @returns What follows it.
 */
function after(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at < 0 ? undefined : args[at + 1];
}

/**
 * The one run a single-run operation makes.
 * @param steps - The steps.
 * @returns Its arguments.
 */
function onlyRun(steps: RunStep[]): string[] {
  expect(steps).toHaveLength(1);
  const [step] = steps;
  if (step?.kind !== "run") throw new Error(`expected a run, got ${step?.kind}`);
  expect(step.program).toBe("ffmpeg");
  return step.args;
}

describe("audio outputs", () => {
  it("writes an audio operation to .m4a and a video one to .mp4", () => {
    for (const op of ["denoise", "normalize", "audio_speed", "audio_cut", "eq", "compress", "pan", "reverb", "voice", "pitch"] as const) {
      expect(outputFileName(op), op).toBe("out.m4a");
    }
    for (const op of ["crop", "speed", "cut", "adjust", "audio_denoise", "stabilize", "hdr"] as const) {
      expect(outputFileName(op), op).toBe("out.mp4");
    }
  });

  it("reads the local source alone, drops cover art and encodes AAC at 192k into a fast-start file", () => {
    const run = onlyRun(opSteps("denoise", { intensity: 50 }, IN, OUT, WORK, audioProbe()));
    expect(run.indexOf("-protocol_whitelist")).toBeLessThan(run.indexOf(IN));
    expect(after(run, "-protocol_whitelist")).toBe("file");
    expect(run).toContain("-vn");
    expect(run.slice(-AAC_OUT.length)).toEqual(AAC_OUT);
  });

  it("refuses a source with no sound for every audio operation", () => {
    const silent: ProbeReport = { streams: [], durationSeconds: 3 };
    for (const op of ["denoise", "normalize", "audio_speed", "audio_cut", "eq", "compress", "pan", "reverb", "voice", "pitch"] as const) {
      expect(inputRefusal(op, silent), op).toBe("no_audio_track");
      expect(inputRefusal(op, audioProbe()), op).toBeNull();
    }
  });

  it("fails an audio output that holds no sound, and a video output that holds no picture", () => {
    expect(outputRefusal({ streams: [], durationSeconds: 1 }, "audio")).toBe("tool_failed");
    expect(outputRefusal(audioProbe(), "audio")).toBeNull();
    expect(outputRefusal(audioProbe(), "video")).toBe("tool_failed");
  });
});

describe("denoise, cut, EQ, compressor", () => {
  it("denoises with the video tool's mapping", () => {
    expect(after(onlyRun(opSteps("denoise", { intensity: 50 }, IN, OUT, WORK, audioProbe())), "-af")).toBe(
      "afftdn=nf=-60.00:nr=19.50",
    );
  });

  it("cuts the range before reading the source", () => {
    const run = onlyRun(opSteps("audio_cut", { range: { start: 1.5, end: 4 } }, IN, OUT, WORK, audioProbe()));
    expect(after(run, "-ss")).toBe("1.500");
    expect(after(run, "-to")).toBe("4.000");
    expect(run.indexOf("-ss")).toBeLessThan(run.indexOf("-i"));
  });

  it("equalises with the shared filter at the source's rate", () => {
    const gains = [0, 0, 0, 0, 0, 0, 0, 0, 3, 6];
    const run = onlyRun(opSteps("eq", { eq: { preset: "custom", gains } }, IN, OUT, WORK, audioProbe(16000)));
    expect(after(run, "-af")).toBe(buildEqFilter(gains, 16000));
  });

  it("compresses with the shared filter", () => {
    const run = onlyRun(opSteps("compress", { dynamics: defaultDynamicsValue }, IN, OUT, WORK, audioProbe()));
    expect(after(run, "-af")).toBe(buildCompressorFilter(defaultDynamicsValue));
  });
});

describe("speed", () => {
  it("keeps the pitch with atempo, chained past its range", () => {
    expect(after(onlyRun(opSteps("audio_speed", { rate: 1.5, keepPitch: true }, IN, OUT, WORK, audioProbe())), "-af")).toBe(
      "atempo=1.500000",
    );
    expect(after(onlyRun(opSteps("audio_speed", { rate: 0.25, keepPitch: true }, IN, OUT, WORK, audioProbe())), "-af")).toBe(
      "atempo=0.500000,atempo=0.500000",
    );
  });

  it("lets the pitch follow the speed by resampling, rounded to whole samples", () => {
    expect(after(onlyRun(opSteps("audio_speed", { rate: 0.75, keepPitch: false }, IN, OUT, WORK, audioProbe(11025))), "-af")).toBe(
      "asetrate=8269,aresample=11025",
    );
  });

  it("cannot let the pitch follow without knowing the source's rate", () => {
    expect(() => opSteps("audio_speed", { rate: 2, keepPitch: false }, IN, OUT, WORK, audioProbe(undefined))).toThrow();
  });
});

describe("pan", () => {
  it("widens without clipping, places the balance, then limits peaks", () => {
    expect(after(onlyRun(opSteps("pan", { pan: -50, width: 200 }, IN, OUT, WORK, audioProbe())), "-af")).toBe(
      "aformat=channel_layouts=stereo,extrastereo=m=2.00:c=0,stereotools=balance_out=-0.50,alimiter=limit=0.89:level=disabled",
    );
  });

  it("folds to mono at width zero", () => {
    expect(after(onlyRun(opSteps("pan", { pan: 0, width: 0 }, IN, OUT, WORK, audioProbe())), "-af")).toContain("extrastereo=m=0.00:c=0");
  });
});

describe("voice enhance", () => {
  it("scales the presence boost, de-essing and compression with the strength", () => {
    expect(after(onlyRun(opSteps("voice", { intensity: 50 }, IN, OUT, WORK, audioProbe())), "-af")).toBe(
      "highpass=f=80,equalizer=f=3000:t=q:w=1:g=3.00,deesser=i=0.25,acompressor=threshold=0.1:ratio=2.00:attack=10:release=150",
    );
  });

  it("re-encodes the source untouched at strength zero", () => {
    expect(after(onlyRun(opSteps("voice", { intensity: 0 }, IN, OUT, WORK, audioProbe())), "-af")).toBeUndefined();
  });
});

describe("normalize", () => {
  const measured = readFileSync(join(FIXTURES, "loudnorm-stderr.txt"), "utf8");
  const silent = readFileSync(join(FIXTURES, "loudnorm-silent-stderr.txt"), "utf8");

  it("reads the measurement off ffmpeg's real stderr", () => {
    expect(readLoudnormMeasure(measured)).toEqual({
      inputI: "-27.15",
      inputTp: "-23.01",
      inputLra: "0.00",
      inputThresh: "-37.15",
      targetOffset: "-0.02",
    });
    expect(readLoudnormMeasure(silent)?.inputI).toBe("-inf");
    expect(readLoudnormMeasure("no json here")).toBeNull();
  });

  it("measures at info level into a null output first", () => {
    const steps = opSteps("normalize", { target: "-16" }, IN, OUT, WORK, audioProbe());
    expect(steps).toHaveLength(1);
    const [step] = steps;
    if (step?.kind !== "measure") throw new Error("expected a measure step");
    expect(after(step.args, "-loglevel")).toBe("info");
    expect(after(step.args, "-af")).toBe("loudnorm=I=-16:TP=-1:LRA=11:print_format=json");
    expect(step.args.slice(-3)).toEqual(["-f", "null", "-"]);
  });

  it("applies the measured values linearly and resamples back by filter", () => {
    const [step] = opSteps("normalize", { target: "-14" }, IN, OUT, WORK, audioProbe(192000));
    if (step?.kind !== "measure") throw new Error("expected a measure step");
    const run = onlyRun(step.then(measured));
    expect(after(run, "-af")).toBe(
      "loudnorm=I=-14:TP=-1:LRA=11:measured_I=-27.15:measured_TP=-23.01:measured_LRA=0.00:measured_thresh=-37.15:offset=-0.02:linear=true,aresample=192000",
    );
    expect(run).not.toContain("-ar");
  });

  it("only resamples a silent source", () => {
    const [step] = opSteps("normalize", { target: "-16" }, IN, OUT, WORK, audioProbe(48000));
    if (step?.kind !== "measure") throw new Error("expected a measure step");
    expect(after(onlyRun(step.then(silent)), "-af")).toBe("aresample=48000");
  });

  it("leaves the rate alone when the probe did not read one", () => {
    const [step] = opSteps("normalize", { target: "-16" }, IN, OUT, WORK, audioProbe(undefined));
    if (step?.kind !== "measure") throw new Error("expected a measure step");
    expect(after(onlyRun(step.then(measured)), "-af")).not.toContain("aresample");
    expect(after(onlyRun(step.then(silent)), "-af")).toBeUndefined();
  });

  it("fails when the measurement cannot be read", () => {
    const [step] = opSteps("normalize", { target: "-16" }, IN, OUT, WORK, audioProbe());
    if (step?.kind !== "measure") throw new Error("expected a measure step");
    expect(() => step.then("garbage")).toThrow();
  });
});

/**
 * The commands of a pipe step.
 * @param steps - The steps.
 * @returns Each command's program and arguments.
 */
function onlyPipe(steps: RunStep[]): { program: string; args: string[] }[] {
  expect(steps).toHaveLength(1);
  const [step] = steps;
  if (step?.kind !== "pipe") throw new Error(`expected a pipe, got ${step?.kind}`);
  return step.commands;
}

describe("pitch", () => {
  it("decodes, shifts through sox and encodes, with no file between them", () => {
    const [decode, shift, encode] = onlyPipe(opSteps("pitch", { semitones: 3, cents: -20 }, IN, OUT, WORK, audioProbe()));
    expect(decode).toEqual({
      program: "ffmpeg",
      args: ["-hide_banner", "-loglevel", "error", "-y", "-protocol_whitelist", "file", "-i", IN, "-vn", "-f", "wav", "-"],
    });
    expect(shift).toEqual({ program: "sox", args: ["-t", "wav", "-", "-t", "wav", "-", "pitch", "280"] });
    expect(encode?.program).toBe("ffmpeg");
    expect(after(encode!.args, "-f")).toBe("wav");
    expect(after(encode!.args, "-i")).toBe("-");
    expect(encode!.args.slice(-AAC_OUT.length)).toEqual(AAC_OUT);
  });

  it("re-encodes the source untouched when nothing is shifted", () => {
    expect(after(onlyRun(opSteps("pitch", { semitones: 0, cents: 0 }, IN, OUT, WORK, audioProbe())), "-af")).toBeUndefined();
  });
});

describe("reverb", () => {
  it("adds the room's wet sound to the dry source at full level, keeping the tail", () => {
    const [decode, room, mix] = onlyPipe(opSteps("reverb", { room: "large_room", amount: 50 }, IN, OUT, WORK, audioProbe()));
    expect(decode?.args.slice(-3)).toEqual(["-f", "wav", "-"]);
    // Audacity's Large Room: reverberance 40, damping 50, room 85, stereo 90, pre-delay 10, wet 0.
    expect(room).toEqual({
      program: "sox",
      args: ["-t", "wav", "-", "-t", "wav", "-", "pad", "0", "2", "reverb", "-w", "40", "50", "85", "90", "10", "0"],
    });
    expect(mix?.program).toBe("ffmpeg");
    expect(mix!.args.filter((arg) => arg === "-i")).toHaveLength(2);
    expect(after(mix!.args, "-filter_complex")).toBe(
      "[1]volume=0.00dB[w];[0][w]amix=inputs=2:normalize=0:duration=longest",
    );
    expect(mix!.args.slice(-AAC_OUT.length)).toEqual(AAC_OUT);
  });

  it("scales only the wet sound with the amount", () => {
    const wetOf = (amount: number): string | undefined => {
      const [, , mix] = onlyPipe(opSteps("reverb", { room: "large_room", amount }, IN, OUT, WORK, audioProbe()));
      return after(mix!.args, "-filter_complex");
    };
    expect(wetOf(100)).toContain("[1]volume=6.02dB[w]");
    expect(wetOf(25)).toContain("[1]volume=-6.02dB[w]");
    expect(wetOf(1)).toContain("[0][w]amix");
  });

  it("gives the longer rooms a longer tail", () => {
    const tailOf = (room: string): string | undefined => {
      const [, sox] = onlyPipe(opSteps("reverb", { room, amount: 50 }, IN, OUT, WORK, audioProbe()));
      return sox!.args[sox!.args.indexOf("pad") + 2];
    };
    expect(tailOf("small_room")).toBe("2");
    expect(tailOf("cathedral")).toBe("4");
    expect(tailOf("bathroom")).toBe("4");
  });

  it("takes each preset's room and wet gain from Audacity's factory presets", () => {
    const reverbArgs = (room: string): string[] => {
      const [, sox] = onlyPipe(opSteps("reverb", { room, amount: 50 }, IN, OUT, WORK, audioProbe()));
      return sox!.args.slice(sox!.args.indexOf("-w") + 1);
    };
    expect(reverbArgs("bathroom")).toEqual(["80", "0", "16", "100", "8", "-6"]);
    expect(reverbArgs("small_room")).toEqual(["50", "50", "30", "100", "10", "-1"]);
    expect(reverbArgs("medium_room")).toEqual(["40", "50", "75", "70", "10", "-1"]);
    expect(reverbArgs("church_hall")).toEqual(["60", "50", "90", "100", "32", "0"]);
    expect(reverbArgs("cathedral")).toEqual(["90", "50", "90", "100", "16", "0"]);
  });

  it("re-encodes the source untouched at amount zero", () => {
    expect(after(onlyRun(opSteps("reverb", { room: "cathedral", amount: 0 }, IN, OUT, WORK, audioProbe())), "-af")).toBeUndefined();
  });
});
