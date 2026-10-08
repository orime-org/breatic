// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The ffmpeg runs each mini-tool container operation makes (inner#888 §8.3).
 * Crop, speed, cut, adjust and audio denoise keep the filters the worker's
 * handlers used; stabilisation is two vidstab passes and HDR is zscale into
 * BT.2020 with PQ or HLG at 10 bits.
 */

import { describe, expect, it } from "vitest";
import { buildAdjustVideoFilter, defaultAdjustValue } from "@breatic/shared";

import { inputRefusal, opRuns, outputRefusal } from "@ingest/jobs/op-args.js";
import type { ProbeReport } from "@ingest/media-metadata.js";

const IN = "/tmp/job/source";
const OUT = "/tmp/job/out.mp4";
const WORK = "/tmp/job";
const EVEN = "scale=trunc(iw/2)*2:trunc(ih/2)*2";

/**
 * The value after a flag in one run.
 * @param args - The run's arguments.
 * @param flag - The flag.
 * @returns What follows it.
 */
function after(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at < 0 ? undefined : args[at + 1];
}

describe("opRuns", () => {
  it("crops to the rectangle on even sizes, keeping the sound", () => {
    const [run] = opRuns("crop", { aspect: "free", rect: { x: 11, y: 5, w: 641, h: 361 } }, IN, OUT, WORK, videoProbe());
    expect(after(run!, "-vf")).toBe("crop=640:360:11:5");
    expect(after(run!, "-c:a")).toBe("copy");
    expect(run!.at(-1)).toBe(OUT);
  });

  it("changes speed on both tracks, chaining atempo past its range", () => {
    const [fast] = opRuns("speed", { rate: 2 }, IN, OUT, WORK, videoProbe());
    expect(after(fast!, "-filter:v")).toBe(`${EVEN},setpts=PTS/2.000000`);
    expect(after(fast!, "-filter:a")).toBe("atempo=2.000000");
    const [slow] = opRuns("speed", { rate: 0.25 }, IN, OUT, WORK, videoProbe());
    expect(after(slow!, "-filter:a")).toBe("atempo=0.500000,atempo=0.500000");
  });

  it("cuts the range the panel set", () => {
    const [run] = opRuns("cut", { range: { start: 1.5, end: 4 } }, IN, OUT, WORK, videoProbe());
    expect(after(run!, "-ss")).toBe("1.500");
    expect(after(run!, "-to")).toBe("4.000");
  });

  it("adjusts with the filter the panel's sliders describe", () => {
    const value = { ...defaultAdjustValue, contrast: 20 };
    const [run] = opRuns("adjust", { value }, IN, OUT, WORK, videoProbe());
    expect(after(run!, "-vf")).toBe(`${EVEN},${buildAdjustVideoFilter(value)}`);
  });

  it("denoises the sound and copies the picture", () => {
    const [run] = opRuns("audio_denoise", { intensity: 50 }, IN, OUT, WORK, videoProbe());
    expect(after(run!, "-af")).toBe("afftdn=nf=-60.00:nr=19.50");
    expect(after(run!, "-c:v")).toBe("copy");
  });

  it("stabilises in two passes over one transform file", () => {
    const runs = opRuns("stabilize", { shakiness: 7, smoothing: 15 }, IN, OUT, WORK, videoProbe());
    expect(runs).toHaveLength(2);
    expect(after(runs[0]!, "-vf")).toBe(`${EVEN},vidstabdetect=shakiness=7:result=/tmp/job/transforms.trf`);
    expect(after(runs[1]!, "-vf")).toBe(`${EVEN},vidstabtransform=smoothing=15:input=/tmp/job/transforms.trf`);
    expect(runs[1]!.at(-1)).toBe(OUT);
  });

  it("converts to BT.2020 at 10 bits with the chosen transfer, tagged on the stream", () => {
    const [pq] = opRuns("hdr", { transfer: "pq" }, IN, OUT, WORK, videoProbe());
    expect(after(pq!, "-vf")).toContain("zscale=p=bt2020:t=smpte2084:m=bt2020nc");
    expect(after(pq!, "-c:v")).toBe("libx265");
    expect(after(pq!, "-pix_fmt")).toBe("yuv420p10le");
    expect(after(pq!, "-color_trc")).toBe("smpte2084");
    expect(after(pq!, "-color_primaries")).toBe("bt2020");

    const [hlg] = opRuns("hdr", { transfer: "hlg" }, IN, OUT, WORK, videoProbe());
    expect(after(hlg!, "-vf")).toContain("t=arib-std-b67");
    expect(after(hlg!, "-color_trc")).toBe("arib-std-b67");
  });

  // An untagged source leaves the linear step's output primaries unknown, and
  // zimg then finds no path between colorspaces ("code 3074").
  it("names the primaries the linear step writes", () => {
    const [pq] = opRuns("hdr", { transfer: "pq" }, IN, OUT, WORK, videoProbe());
    const linear = after(pq!, "-vf")!.split(",")[1]!;
    expect(linear.split(":")).toContain("p=bt709");
  });
});

describe("inputRefusal", () => {
  const stream = (codecType: string) => ({
    index: 0,
    codecType,
    codecName: null,
    width: null,
    height: null,
    attachedPic: false,
  });
  const probe = (...types: string[]): ProbeReport => ({ streams: types.map(stream), durationSeconds: 3 });

  // §8.3: denoise works on the sound, so a video without one fails as such.
  it("refuses audio denoise on a source with no sound", () => {
    expect(inputRefusal("audio_denoise", probe("video"))).toBe("no_audio_track");
    expect(inputRefusal("audio_denoise", probe("video", "audio"))).toBeNull();
  });

  it("lets the picture operations run on a silent source", () => {
    for (const op of ["crop", "speed", "cut", "adjust", "stabilize", "hdr"] as const) {
      expect(inputRefusal(op, probe("video"))).toBeNull();
    }
  });
});

/** A probe of a video stream and an audio stream of the codecs given. */
function codecProbe(video: string, audio: string): ProbeReport {
  return {
    streams: [
      { index: 0, codecType: "video", codecName: video, width: 640, height: 360, attachedPic: false },
      { index: 1, codecType: "audio", codecName: audio, width: null, height: null, attachedPic: false },
    ],
    durationSeconds: 8,
  };
}

// The output is always an .mp4 a browser opens: a stream is copied only when
// that file can carry it and the browsers play it there, and re-encoded
// otherwise (ProRes and VP8 do not go into mp4; Vorbis in mp4 has no sound in
// Safari).
describe("streams copied into the output", () => {
  const copies = (run: readonly string[], kind: "v" | "a"): boolean =>
    after(run, `-c:${kind}`) === "copy" || after(run, "-c") === "copy";

  it("copies a browser-safe source and re-encodes the rest", () => {
    const safe = codecProbe("h264", "aac");
    const prores = codecProbe("prores", "pcm_s16le");
    const vp8 = codecProbe("vp8", "vorbis");
    for (const [op, params] of [
      ["crop", { rect: null }],
      ["audio_denoise", { intensity: 50 }],
    ] as const) {
      const [okRun] = opRuns(op, params, IN, OUT, WORK, safe);
      expect(copies(okRun!, "v"), op).toBe(true);
      for (const probe of [prores, vp8]) {
        const [run] = opRuns(op, params, IN, OUT, WORK, probe);
        expect(copies(run!, "v"), op).toBe(false);
        expect(after(run!, "-c:v"), op).toBe("libx264");
      }
    }
  });

  it("re-encodes sound an mp4 does not play to AAC, and copies the rest", () => {
    for (const [op, params] of [
      ["crop", { rect: { x: 0, y: 0, w: 320, h: 180 } }],
      ["crop", { rect: null }],
      ["adjust", { value: defaultAdjustValue }],
      ["stabilize", { shakiness: 5, smoothing: 10 }],
      ["hdr", { transfer: "pq" }],
    ] as const) {
      const last = (probe: ProbeReport): string[] => opRuns(op, params, IN, OUT, WORK, probe).at(-1)!;
      expect(copies(last(codecProbe("h264", "aac")), "a"), op).toBe(true);
      for (const audio of ["vorbis", "pcm_s16le", "flac"]) {
        expect(after(last(codecProbe("h264", audio)), "-c:a"), `${op} ${audio}`).toBe("aac");
      }
    }
  });

  // An HEVC stream copied into mp4 is tagged hev1 by default, which Safari does not open.
  it("tags a copied HEVC stream the way Safari opens", () => {
    const [run] = opRuns("audio_denoise", { intensity: 50 }, IN, OUT, WORK, codecProbe("hevc", "aac"));
    expect(after(run!, "-c:v")).toBe("copy");
    expect(after(run!, "-tag:v")).toBe("hvc1");
  });
});

/** A probe of one video stream, with the colour tags given. */
function videoProbe(tags: { colorTransfer?: string; colorPrimaries?: string; colorSpace?: string } = {}): ProbeReport {
  return {
    streams: [{ index: 0, codecType: "video", codecName: "h264", width: 640, height: 360, attachedPic: false, ...tags }],
    durationSeconds: 8,
  };
}

describe("the runs every encoding operation shares", () => {
  const encoding = [
    ["speed", { rate: 2 }],
    ["cut", { range: { start: 1, end: 2 } }],
    ["adjust", { value: defaultAdjustValue }],
    ["stabilize", { shakiness: 5, smoothing: 10 }],
    ["hdr", { transfer: "pq" }],
  ] as const;

  // An odd-sized source is legal, and the encoders, vidstab and zscale all
  // refuse odd sides, so the rounding comes before every other filter.
  it("rounds the frame to even sides before any other filter", () => {
    for (const [op, params] of encoding) {
      for (const run of opRuns(op, params, IN, OUT, WORK, videoProbe())) {
        const filter = after(run, "-vf") ?? after(run, "-filter:v") ?? "";
        expect(filter.startsWith(`${EVEN},`) || filter === EVEN, `${op}: ${filter}`).toBe(true);
      }
    }
  });

  // The source is the copy the container downloaded first; nothing else is opened.
  it("reads the source as a local file alone", () => {
    for (const [op, params] of [...encoding, ["crop", { rect: null }], ["audio_denoise", { intensity: 50 }]] as const) {
      for (const run of opRuns(op, params, IN, OUT, WORK, videoProbe())) {
        if (!run.includes(IN)) continue;
        expect(run.indexOf("-protocol_whitelist"), op).toBeGreaterThanOrEqual(0);
        expect(after(run, "-protocol_whitelist"), op).toBe("file");
        expect(run.indexOf("-protocol_whitelist"), op).toBeLessThan(run.indexOf(IN));
      }
    }
  });
});

describe("HDR colour", () => {
  it("reads the source as its own tags say", () => {
    const [run] = opRuns("hdr", { transfer: "pq" }, IN, OUT, WORK, videoProbe({ colorTransfer: "arib-std-b67", colorPrimaries: "bt2020", colorSpace: "bt2020nc" }));
    expect(after(run!, "-vf")).toContain(`${EVEN},zscale=tin=arib-std-b67:pin=bt2020:min=bt2020nc:`);
  });

  it("reads a tag it lacks, or one zscale does not know, as BT.709", () => {
    const [run] = opRuns("hdr", { transfer: "pq" }, IN, OUT, WORK, videoProbe({ colorTransfer: "gamma22" }));
    expect(after(run!, "-vf")).toContain(`${EVEN},zscale=tin=bt709:pin=bt709:min=bt709:`);
  });

  // SDR white lands at 203 nits; the HDR step is where zimg uses the peak.
  it("names the nominal peak on the step that writes the HDR transfer", () => {
    const [run] = opRuns("hdr", { transfer: "pq" }, IN, OUT, WORK, videoProbe());
    expect(after(run!, "-vf")).toContain("zscale=p=bt2020:t=smpte2084:m=bt2020nc:r=tv:npl=203");
  });
});

describe("outputRefusal", () => {
  it("fails an output with no picture", () => {
    expect(outputRefusal({ streams: [{ index: 0, codecType: "audio", codecName: "aac", width: null, height: null, attachedPic: false }], durationSeconds: 1 })).toBe("tool_failed");
    expect(outputRefusal(videoProbe())).toBeNull();
  });
});
