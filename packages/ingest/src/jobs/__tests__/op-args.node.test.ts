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

import { inputRefusal, opRuns } from "@ingest/jobs/op-args.js";
import type { ProbeReport } from "@ingest/media-metadata.js";

const IN = "http://r2.local/video/in.mp4";
const OUT = "/tmp/job/out.mp4";
const WORK = "/tmp/job";

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
    const [run] = opRuns("crop", { aspect: "free", rect: { x: 11, y: 5, w: 641, h: 361 } }, IN, OUT, WORK);
    expect(after(run!, "-vf")).toBe("crop=640:360:11:5");
    expect(after(run!, "-c:a")).toBe("copy");
    expect(run!.at(-1)).toBe(OUT);
  });

  it("changes speed on both tracks, chaining atempo past its range", () => {
    const [fast] = opRuns("speed", { rate: 2 }, IN, OUT, WORK);
    expect(after(fast!, "-filter:v")).toBe("setpts=PTS/2.000000");
    expect(after(fast!, "-filter:a")).toBe("atempo=2.000000");
    const [slow] = opRuns("speed", { rate: 0.25 }, IN, OUT, WORK);
    expect(after(slow!, "-filter:a")).toBe("atempo=0.500000,atempo=0.500000");
  });

  it("cuts the range the panel set", () => {
    const [run] = opRuns("cut", { range: { start: 1.5, end: 4 } }, IN, OUT, WORK);
    expect(after(run!, "-ss")).toBe("1.500");
    expect(after(run!, "-to")).toBe("4.000");
  });

  it("adjusts with the filter the panel's sliders describe", () => {
    const value = { ...defaultAdjustValue, contrast: 20 };
    const [run] = opRuns("adjust", { value }, IN, OUT, WORK);
    expect(after(run!, "-vf")).toBe(buildAdjustVideoFilter(value));
  });

  it("denoises the sound and copies the picture", () => {
    const [run] = opRuns("audio_denoise", { intensity: 50 }, IN, OUT, WORK);
    expect(after(run!, "-af")).toBe("afftdn=nf=-60.00:nr=19.50");
    expect(after(run!, "-c:v")).toBe("copy");
  });

  it("stabilises in two passes over one transform file", () => {
    const runs = opRuns("stabilize", { shakiness: 7, smoothing: 15 }, IN, OUT, WORK);
    expect(runs).toHaveLength(2);
    expect(after(runs[0]!, "-vf")).toBe("vidstabdetect=shakiness=7:result=/tmp/job/transforms.trf");
    expect(after(runs[1]!, "-vf")).toBe("vidstabtransform=smoothing=15:input=/tmp/job/transforms.trf");
    expect(runs[1]!.at(-1)).toBe(OUT);
  });

  it("converts to BT.2020 at 10 bits with the chosen transfer, tagged on the stream", () => {
    const [pq] = opRuns("hdr", { transfer: "pq" }, IN, OUT, WORK);
    expect(after(pq!, "-vf")).toContain("zscale=p=bt2020:t=smpte2084:m=bt2020nc");
    expect(after(pq!, "-c:v")).toBe("libx265");
    expect(after(pq!, "-pix_fmt")).toBe("yuv420p10le");
    expect(after(pq!, "-color_trc")).toBe("smpte2084");
    expect(after(pq!, "-color_primaries")).toBe("bt2020");

    const [hlg] = opRuns("hdr", { transfer: "hlg" }, IN, OUT, WORK);
    expect(after(hlg!, "-vf")).toContain("t=arib-std-b67");
    expect(after(hlg!, "-color_trc")).toBe("arib-std-b67");
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
