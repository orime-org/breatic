// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The ffmpeg run that joins clips (inner#1825 §6.4). A video join takes its
 * frame size and rate from the first clip, fits every other clip inside that
 * frame centred, gives a clip without sound a silent track of its own length
 * so the output always has one, and either concatenates or crossfades
 * neighbours, the crossfade held to half the shorter of the two. An audio join
 * resamples to the first clip's rate and channels and writes an .m4a.
 *
 * The clips after the first come to `opSteps` as their local paths and
 * probes, in joining order.
 */

import { describe, expect, it } from "vitest";

import { mediumOf, opSteps, outputFileName, type RunStep } from "@ingest/jobs/op-args.js";
import type { ContainerOp } from "@shared/mini-tools/types.js";
import type { ProbeReport } from "@ingest/media-metadata.js";

const WORK = "/tmp/job";
const IN = `${WORK}/source`;
const OUT_VIDEO = `${WORK}/out.mp4`;
const OUT_AUDIO = `${WORK}/out.m4a`;

/** One clip after the first, as the container hands it to `opSteps`. */
interface ExtraInput {
  path: string;
  probe: ProbeReport;
}

/**
 * A video clip's probe.
 * @param width - Its width.
 * @param height - Its height.
 * @param fps - Its frame rate.
 * @param duration - Its length in seconds.
 * @param sound - Whether it carries an audio stream.
 * @returns The probe.
 */
function video(width: number, height: number, fps: number, duration: number, sound = true): ProbeReport {
  return {
    streams: [
      { index: 0, codecType: "video", codecName: "h264", width, height, attachedPic: false, frameRate: fps },
      ...(sound ? [{ index: 1, codecType: "audio", codecName: "aac", width: null, height: null, attachedPic: false, sampleRate: 48000, channels: 2 }] : []),
    ],
    durationSeconds: duration,
  } as ProbeReport;
}

/**
 * An audio clip's probe.
 * @param sampleRate - Its rate.
 * @param channels - Its channel count.
 * @param duration - Its length in seconds.
 * @returns The probe.
 */
function audio(sampleRate: number, channels: number, duration: number): ProbeReport {
  return {
    streams: [{ index: 0, codecType: "audio", codecName: "mp3", width: null, height: null, attachedPic: false, sampleRate, channels }],
    durationSeconds: duration,
  };
}

/**
 * The steps a join makes.
 * @param op - `join` or `audio_join`.
 * @param crossfade - The crossfade in seconds.
 * @param first - The first clip's probe.
 * @param rest - The other clips' probes, in order.
 * @returns The steps.
 */
function joinSteps(op: "join" | "audio_join", crossfade: number, first: ProbeReport, rest: ProbeReport[]): RunStep[] {
  const extra: ExtraInput[] = rest.map((probe, i) => ({ path: `${WORK}/source-${i + 1}`, probe }));
  const output = op === "join" ? OUT_VIDEO : OUT_AUDIO;
  const steps = opSteps as unknown as (
    op: ContainerOp,
    params: Record<string, unknown>,
    input: string,
    output: string,
    workDir: string,
    source: ProbeReport,
    extra: ExtraInput[],
  ) => RunStep[];
  return steps(op as ContainerOp, { crossfade }, IN, output, WORK, first, extra);
}

/**
 * The one ffmpeg run that writes the output.
 * @param steps - The steps.
 * @param output - The output file.
 * @returns Its arguments.
 */
function finalRun(steps: RunStep[], output: string): string[] {
  const last = steps.at(-1);
  if (last?.kind !== "run" || last.program !== "ffmpeg") throw new Error("the join does not end in one ffmpeg run");
  expect(last.args.at(-1)).toBe(output);
  return last.args;
}

/**
 * The files a run reads, in order.
 * @param args - Its arguments.
 * @returns The value after every `-i`.
 */
function inputsOf(args: readonly string[]): string[] {
  return args.flatMap((arg, i) => (arg === "-i" ? [args[i + 1]!] : []));
}

/**
 * The filter graph a run is given.
 * @param args - Its arguments.
 * @returns The `-filter_complex` value.
 */
function graphOf(args: readonly string[]): string {
  const at = args.indexOf("-filter_complex");
  expect(at, "the join runs one filter graph").toBeGreaterThanOrEqual(0);
  return args[at + 1]!;
}

/**
 * Every use of one filter in a graph, its named options read off.
 * @param graph - The graph.
 * @param name - The filter.
 * @returns One option map per use, in order.
 */
function usesOf(graph: string, name: string): Record<string, string>[] {
  return [...graph.matchAll(new RegExp(`(?<![a-z])${name}=([^\\[\\];,]*)`, "g"))].map((match) =>
    Object.fromEntries(match[1]!.split(":").map((pair) => pair.split("=") as [string, string])),
  );
}

describe("join", () => {
  it("writes video into an .mp4", () => {
    expect(mediumOf("join" as ContainerOp)).toBe("video");
    expect(outputFileName("join" as ContainerOp)).toBe("out.mp4");
  });

  it("reads every clip, in joining order, the source first", () => {
    const args = finalRun(joinSteps("join", 0, video(1280, 720, 25, 5), [video(640, 480, 30, 4), video(1920, 1080, 24, 6)]), OUT_VIDEO);
    expect(inputsOf(args).filter((input) => input.startsWith(WORK))).toEqual([IN, `${WORK}/source-1`, `${WORK}/source-2`]);
  });

  it("takes the frame size and rate from the first clip and fits the others inside it, centred", () => {
    const graph = graphOf(finalRun(joinSteps("join", 0, video(1280, 720, 25, 5), [video(640, 480, 30, 4), video(1920, 1080, 24, 6)]), OUT_VIDEO));
    expect(graph).toMatch(/scale=(w=)?1280:(h=)?720/);
    expect(graph).toContain("force_original_aspect_ratio=decrease");
    expect(graph).toMatch(/pad=(w=)?1280:(h=)?720/);
    expect(graph).toMatch(/fps=(fps=)?25(?![\d.])/);
    expect(graph).not.toMatch(/pad=(w=)?1920:(h=)?1080/);
    expect(graph).not.toMatch(/fps=(fps=)?(30|24)(?![\d.])/);
  });

  it("gives a clip without sound a silent track, so the output always has one", () => {
    const silent = finalRun(joinSteps("join", 0, video(1280, 720, 25, 5), [video(1280, 720, 25, 4, false)]), OUT_VIDEO);
    expect(silent.join(" ")).toContain("anullsrc");
    const sounded = finalRun(joinSteps("join", 0, video(1280, 720, 25, 5), [video(1280, 720, 25, 4)]), OUT_VIDEO);
    expect(sounded.join(" ")).not.toContain("anullsrc");
  });

  it("concatenates picture and sound when the crossfade is 0", () => {
    const graph = graphOf(finalRun(joinSteps("join", 0, video(1280, 720, 25, 5), [video(1280, 720, 25, 4), video(1280, 720, 25, 6)]), OUT_VIDEO));
    expect(graph).toMatch(/concat=n=3:v=1:a=1/);
    expect(graph).not.toContain("xfade");
  });

  it("fades each neighbour into the next, offset by the probed lengths, when the crossfade is set", () => {
    const graph = graphOf(finalRun(joinSteps("join", 1, video(1280, 720, 25, 5), [video(1280, 720, 25, 4), video(1280, 720, 25, 6)]), OUT_VIDEO));
    const fades = usesOf(graph, "xfade");
    expect(fades.map((fade) => fade.transition)).toEqual(["fade", "fade"]);
    expect(fades.map((fade) => Number(fade.duration))).toEqual([1, 1]);
    // 5 s, then 4 s whose first second lies over the first clip's last: 5 − 1, then 5 + 4 − 1 − 1.
    expect(fades.map((fade) => Number(fade.offset))).toEqual([4, 7]);
    const sound = usesOf(graph, "acrossfade");
    expect(sound.map((fade) => Number(fade.d ?? fade.duration))).toEqual([1, 1]);
  });

  it("holds each crossfade to half the shorter of its two clips", () => {
    const graph = graphOf(finalRun(joinSteps("join", 2, video(1280, 720, 25, 6), [video(1280, 720, 25, 3), video(1280, 720, 25, 1)]), OUT_VIDEO));
    const fades = usesOf(graph, "xfade");
    // min(6, 3) / 2 and min(3, 1) / 2.
    expect(fades.map((fade) => Number(fade.duration))).toEqual([1.5, 0.5]);
    // 6 − 1.5, then 6 + 3 − 1.5 − 0.5.
    expect(fades.map((fade) => Number(fade.offset))).toEqual([4.5, 7]);
    expect(usesOf(graph, "acrossfade").map((fade) => Number(fade.d ?? fade.duration))).toEqual([1.5, 0.5]);
  });
});

describe("audio_join", () => {
  it("writes audio into an .m4a", () => {
    expect(mediumOf("audio_join" as ContainerOp)).toBe("audio");
    expect(outputFileName("audio_join" as ContainerOp)).toBe("out.m4a");
  });

  it("reads every clip in joining order and concatenates them when the crossfade is 0", () => {
    const args = finalRun(joinSteps("audio_join", 0, audio(44100, 2, 10), [audio(44100, 2, 8), audio(44100, 2, 12)]), OUT_AUDIO);
    expect(inputsOf(args)).toEqual([IN, `${WORK}/source-1`, `${WORK}/source-2`]);
    const graph = graphOf(args);
    expect(graph).toMatch(/concat=n=3:v=0:a=1/);
    expect(graph).not.toContain("acrossfade");
  });

  it("takes the sample rate and channels from the first clip", () => {
    const args = finalRun(joinSteps("audio_join", 0, audio(44100, 1, 10), [audio(48000, 2, 8)]), OUT_AUDIO).join(" ");
    expect(args).toMatch(/(sample_rates=|aresample=|-ar )44100/);
    expect(args).toMatch(/channel_layouts=mono|-ac 1(?!\d)/);
    expect(args).not.toMatch(/(sample_rates=|aresample=|-ar )48000/);
  });

  it("crossfades neighbours when the crossfade is set, held to half the shorter clip", () => {
    const graph = graphOf(finalRun(joinSteps("audio_join", 3, audio(44100, 2, 10), [audio(44100, 2, 4), audio(44100, 2, 12)]), OUT_AUDIO));
    // min(10, 4) / 2 and min(4, 12) / 2.
    expect(usesOf(graph, "acrossfade").map((fade) => Number(fade.d ?? fade.duration))).toEqual([2, 2]);
    expect(graph).not.toMatch(/concat=/);
  });
});
