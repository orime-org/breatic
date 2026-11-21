// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  chooseFrameGridRate,
  isVariableFrameRate,
  type FrameGridRate,
  type FrameGridRateInput,
  type FrameRate,
} from "../frame-grid-rate.js";

interface PacketSample {
  file: string;
  rFrameRate: string | null;
  avgFrameRate: string | null;
  ticksPerSecond: string;
  firstTick: number;
  tickDeltas: number[];
  expectedFps: string;
  expectedPath: string;
}

const MAX_FPS = 120;

/**
 * The packet scan of a stream with no average rate and no `r_frame_rate`, timed in microseconds.
 * @param gaps - Adjacent packet gaps in microseconds, in packet order.
 * @returns The rate rule's result.
 */
function scanOf(gaps: readonly number[]): FrameGridRate {
  const ticks = gaps.reduce<number[]>((times, gap) => [...times, times[times.length - 1]! + gap], [0]);
  return chooseFrameGridRate({ rFrameRate: null, avgFrameRate: null, ticksPerSecond: { numerator: 1_000_000, denominator: 1 }, ticks, maxFps: MAX_FPS });
}

/** Parses an ffprobe-style rational ("30000/1001" or "30") into a reduced frame rate. */
function rational(text: string): FrameRate {
  const [n, d = "1"] = text.split("/");
  const numerator = Number(n);
  const denominator = Number(d);
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(numerator, denominator);
  return { numerator: numerator / g, denominator: denominator / g };
}

const samples: PacketSample[] = (
  JSON.parse(gunzipSync(readFileSync(resolve(__dirname, "fixtures/frame-grid-packets.json.gz"))).toString("utf8")) as {
    files: PacketSample[];
  }
).files;

/** Builds the rule input of one sample: packet times in packet order, as the probe reads them. */
function inputOf(sample: PacketSample): FrameGridRateInput {
  const ticks = [sample.firstTick];
  for (const delta of sample.tickDeltas) ticks.push(ticks[ticks.length - 1]! + delta);
  return {
    rFrameRate: sample.rFrameRate === null ? null : rational(sample.rFrameRate),
    avgFrameRate: sample.avgFrameRate === null ? null : rational(sample.avgFrameRate),
    ticksPerSecond: rational(sample.ticksPerSecond),
    ticks,
    maxFps: MAX_FPS,
  };
}

/** Maps the reference harness path label ("avg_invalid:snapped", "r_over_max:mux30(0.25)") to the rule's result. */
function expectedOf(sample: PacketSample): FrameGridRate {
  const steps: Record<string, FrameGridRate["step"]> = {
    nominal: "nominal", single: "singleFrame", lattice: "lattice", r_frame_rate: "rFrameRate", snapped: "medianSnapped",
    sf_up: "trimmedMean", rounded: "rounded", mux30: "outOfRange",
  };
  const reasons: Record<string, NonNullable<FrameGridRate["scanReason"]>> = {
    avg_invalid: "avgInvalid", r_over_max: "rOverMax", guess_avg: "guessAvg", r_unnamed: "rUnnamed",
  };
  const parts = sample.expectedPath.split(":");
  const step = steps[parts[parts.length - 1]!.replace(/\(.*\)$/, "")]!;
  return { fps: rational(sample.expectedFps), step, scanReason: parts.length > 1 ? reasons[parts[0]!]! : null };
}

/** Finds one fixture sample by its path under the sample set. */
function sample(file: string): PacketSample {
  const found = samples.find((s) => s.file === file);
  if (!found) throw new Error(`no fixture sample ${file}`);
  return found;
}

/** The rule's frame rate for one fixture sample. */
function fpsOf(file: string): FrameRate {
  return chooseFrameGridRate(inputOf(sample(file))).fps;
}

describe("frame-grid rate rule (frame-grid design §4.1)", () => {
  it("G17: every one of the 302 samples gets the reference rate and step", () => {
    expect(samples).toHaveLength(302);
    const wrong = samples
      .map((s) => ({ file: s.file, got: chooseFrameGridRate(inputOf(s)), want: expectedOf(s) }))
      .filter((r) => JSON.stringify(r.got) !== JSON.stringify(r.want));
    expect(wrong).toEqual([]);
  });

  it("G01: a 59.94 Matroska file stored as 19001/317 is normalised to 60000/1001", () => {
    expect(fpsOf("round11/s9/mkv_60000_1001.mkv")).toEqual({ numerator: 60000, denominator: 1001 });
    expect(chooseFrameGridRate(inputOf(sample("round11/s9/mkv_60000_1001.mkv"))).step).toBe("nominal");
  });

  it("G02: any one scan condition sends the file to the packet scan", () => {
    const recording = chooseFrameGridRate(inputOf(sample("round6/long3.webm")));
    expect(recording).toEqual({ fps: { numerator: 30, denominator: 1 }, step: "medianSnapped", scanReason: "avgInvalid" });
    const chromeMp4 = chooseFrameGridRate(inputOf(sample("round8/m4_60_0.mp4")));
    expect(chromeMp4.scanReason).toBe("rOverMax");
    expect(chromeMp4.fps).toEqual({ numerator: 60, denominator: 1 });
  });

  it("G03: an unnamed r_frame_rate 0.1% or more from the whole-file mean is scanned; fixed 12.5 and 7.5 are kept", () => {
    expect(chooseFrameGridRate(inputOf(sample("round7/m4_10_0.mp4")))).toMatchObject({ fps: { numerator: 10, denominator: 1 }, scanReason: "rUnnamed" });
    expect(fpsOf("round7/c12_5.mp4")).toEqual({ numerator: 25, denominator: 2 });
    expect(fpsOf("round7/c7_5.webm")).toEqual({ numerator: 15, denominator: 2 });
  });

  it("G04: jittered fixed 7.5 and 12.5 fps files keep 15/2 and 25/2", () => {
    expect(fpsOf("round11/s9/jit7_5_s3_90000.mp4")).toEqual({ numerator: 15, denominator: 2 });
    expect(fpsOf("round11/s9/jit12_5_s4_1000000.mp4")).toEqual({ numerator: 25, denominator: 2 });
  });

  it("G05: the scan reads every packet, so a recording that types first and moves later gets 60", () => {
    expect(fpsOf("round11/s9/chrome_type_then_motion.webm")).toEqual({ numerator: 60, denominator: 1 });
  });

  it("G06: the integer-multiple fit gives 60 for a 60 Hz recording with dropped frames", () => {
    expect(chooseFrameGridRate(inputOf(sample("round10/hr/c50_h60.webm")))).toMatchObject({ fps: { numerator: 60, denominator: 1 }, step: "lattice" });
  });

  it("G07: the default-window r_frame_rate passing the 1 ms landing check is taken when the fit fails", () => {
    expect(chooseFrameGridRate(inputOf(sample("round11/s9/film23976.webm")))).toMatchObject({ fps: { numerator: 60, denominator: 1 }, step: "rFrameRate" });
    expect(chooseFrameGridRate(inputOf(sample("round11/long/film_h59.951.webm")))).toMatchObject({
      fps: { numerator: 60000, denominator: 1001 }, step: "rFrameRate",
    });
  });

  it("G08: the median of an even number of gaps averages the rates of the middle two", () => {
    // Middle gaps 30 ms and 40 ms give 33.33 and 25 fps, averaging 29.17, which snaps to nothing; the trimmed mean of
    // 26.67 snaps to nothing either, so the median is rounded to 29.
    expect(scanOf([20_000, 30_000, 40_000, 60_000])).toEqual({ fps: { numerator: 29, denominator: 1 }, step: "rounded", scanReason: "avgInvalid" });
  });

  it("G09: the trimmed mean is taken when it snaps higher than the median", () => {
    expect(chooseFrameGridRate(inputOf(sample("round10/hr/c30_h75.webm")))).toMatchObject({ fps: { numerator: 30, denominator: 1 }, step: "trimmedMean" });
    expect(chooseFrameGridRate(inputOf(sample("round10/hr2/c60_h165.webm")))).toMatchObject({ fps: { numerator: 60, denominator: 1 }, step: "trimmedMean" });
    expect(fpsOf("round10/syn/s_jit60_still30.webm")).toEqual({ numerator: 60, denominator: 1 });
  });

  it("G09: the trimmed mean skips gaps under 1/240 s and leaves out gaps over 0.1 s", () => {
    // The 2 ms gap folds into the next one and the five 150 ms gaps are left out: four gaps of about 16.66 ms give 60.
    // Counting the 2 ms gap gives 75 and counting the idle gaps gives 11, neither of which snaps, and the median of
    // 33.27 fps does not snap either, so only the trimmed-mean rules give 60.
    expect(scanOf([2_000, 14_600, 16_700, 16_650, 16_690, 150_000, 150_000, 150_000, 150_000, 150_000]))
      .toEqual({ fps: { numerator: 60, denominator: 1 }, step: "trimmedMean", scanReason: "avgInvalid" });
  });

  it("G10: a trimmed mean that snaps lower keeps the median on the stalled recordings", () => {
    const jank = samples.filter((s) => s.file.startsWith("round11/jank/"));
    expect(jank).toHaveLength(24);
    for (const s of jank) expect(chooseFrameGridRate(inputOf(s)).fps, s.file).toEqual(expectedOf(s).fps);
  });

  it("G11: a scan estimate under 5 or over 120 fps gets 30", () => {
    expect(chooseFrameGridRate(inputOf(sample("round8/slides.webm")))).toMatchObject({ fps: { numerator: 30, denominator: 1 }, step: "outOfRange" });
    expect(chooseFrameGridRate(inputOf(sample("round11/s9/slomo240.mp4")))).toMatchObject({ fps: { numerator: 30, denominator: 1 }, step: "outOfRange" });
  });

  it("G12: rates snap to common rates", () => {
    // The middle gap sets the median; the other gaps keep the trimmed mean near 27 fps, which snaps to nothing.
    /**
     * The scan result for a median gap of `gap` microseconds.
     * @param gap - The middle gap.
     * @returns The rate and step.
     */
    const median = (gap: number): Pick<FrameGridRate, "fps" | "step"> => {
      const { fps, step } = scanOf([20_000, 25_000, gap, 50_000, 56_815]);
      return { fps, step };
    };
    expect(median(41_667)).toEqual({ fps: { numerator: 24, denominator: 1 }, step: "medianSnapped" });
    // 29.9895 fps is 0.065% from 30000/1001 and 0.035% from 30.
    expect(median(33_345)).toEqual({ fps: { numerator: 30, denominator: 1 }, step: "medianSnapped" });
    // 29.967 fps is within 0.05% of 30000/1001.
    expect(median(33_370)).toEqual({ fps: { numerator: 30000, denominator: 1001 }, step: "medianSnapped" });
    // 26.5 fps is more than 2.5% from 25 and 30, so it is rounded.
    expect(median(37_736)).toEqual({ fps: { numerator: 26, denominator: 1 }, step: "rounded" });
  });

  it("G13: fewer than two distinct timestamps give 25", () => {
    expect(chooseFrameGridRate(inputOf(sample("round6/one_a.webm")))).toEqual({ fps: { numerator: 25, denominator: 1 }, step: "singleFrame", scanReason: null });
    expect(chooseFrameGridRate({ rFrameRate: { numerator: 30, denominator: 1 }, avgFrameRate: null, ticksPerSecond: { numerator: 1000, denominator: 1 }, ticks: [5, 5], maxFps: MAX_FPS }).fps)
      .toEqual({ numerator: 25, denominator: 1 });
  });

  it("G14: packets timed by dts give 25/2 for H.264 in AVI", () => {
    expect(fpsOf("round11/dts/avi_h264_12_5.avi")).toEqual({ numerator: 25, denominator: 2 });
  });

  it("G16: browser-recorded WebM files take the scan estimate", () => {
    for (const file of ["round11/s8/raf30a_jank.webm", "round7/w9_60_0.3.webm", "round10/syn/s_jit60_nostill.webm"]) {
      expect(chooseFrameGridRate(inputOf(sample(file))).scanReason, file).toBe("avgInvalid");
      expect(fpsOf(file), file).toEqual(expectedOf(sample(file)).fps);
    }
  });

  it("G18: the result is a positive rate no higher than the cap, and shifting every timestamp does not change it", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 400 }), { minLength: 1, maxLength: 120 }),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.constantFrom<FrameRate | null>(null, { numerator: 30, denominator: 1 }, { numerator: 1000, denominator: 1 }),
        (gaps, shift, rFrameRate) => {
          const ticks = gaps.reduce<number[]>((all, gap) => [...all, all[all.length - 1]! + gap], [0]);
          const input: FrameGridRateInput = { rFrameRate, avgFrameRate: null, ticksPerSecond: { numerator: 1000, denominator: 1 }, ticks, maxFps: MAX_FPS };
          const result = chooseFrameGridRate(input);
          const fps = result.fps.numerator / result.fps.denominator;
          expect(fps).toBeGreaterThanOrEqual(5);
          expect(fps).toBeLessThanOrEqual(MAX_FPS);
          expect(chooseFrameGridRate({ ...input, ticks: ticks.map((t) => t + shift) })).toEqual(result);
        },
      ),
    );
  });
});

describe("variable frame rate test (frame-grid design §4.2, after MLT find_first_pts)", () => {
  const nominal = { numerator: 30000, denominator: 1001 };

  it("G15: a 29.97 Matroska file is constant rate: its packet durations come from DefaultDuration, its timestamps alternate", () => {
    const durations = Array(20).fill(33);
    expect(isVariableFrameRate({ packetDurations: durations, avgFrameRate: { numerator: 30000, denominator: 1001 }, rFrameRate: nominal })).toBe(false);
  });

  it("G15: three or more duration changes in the first 20 packets mean variable rate", () => {
    const durations = [33, 33, 50, 33, 50, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33];
    expect(isVariableFrameRate({ packetDurations: durations, avgFrameRate: nominal, rFrameRate: nominal })).toBe(true);
  });

  it("G15: an average rate whose denominator is outside {0,1,2,125,1001} and differs from the nominal rate means variable rate", () => {
    expect(isVariableFrameRate({ packetDurations: Array(20).fill(33), avgFrameRate: { numerator: 8985000, denominator: 159023 }, rFrameRate: { numerator: 60, denominator: 1 } })).toBe(true);
  });
});
