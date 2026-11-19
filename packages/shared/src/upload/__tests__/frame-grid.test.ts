// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  audioGridEnd,
  decodePrerollFrames,
  gridFilterChain,
  gridFrameTime,
  gridLandingLate,
  gridSeekPosition,
  planFrameGrid,
  sourceKeyframeStats,
  type SourceKeyframeStats,
  type SourcePacket,
} from "../frame-grid.js";
import type { FrameRate } from "../frame-grid-rate.js";

interface GridEndSample {
  file: string;
  fps: string;
  videoTimeBase: string;
  firstVideoPts: number;
  lastVideoPts: number;
  audioTimeBase: string;
  lastAudioPts: number;
  lastAudioDuration: number;
  discardPadding: number;
  sampleRate: number;
  firstAudioFramePts: number;
  quantum: string;
  expectedGridEnd: string;
  expectedV: number;
  expectedFrameCount: number;
}

interface KeyframeSample { timeBase: string; packets: [number | null, number | null, number, string][] }

const fixture = JSON.parse(readFileSync(resolve(__dirname, "fixtures/frame-grid-ends.json"), "utf8")) as {
  gridEnds: GridEndSample[];
  keyframePackets: Record<string, KeyframeSample>;
};

/** Parses "30000/1001" or "30" into a rational. */
function rational(text: string): FrameRate {
  const [n, d = "1"] = text.split("/");
  return { numerator: Number(n), denominator: Number(d) };
}

/** A rational's value. */
function value(r: FrameRate): number {
  return r.numerator / r.denominator;
}

/** Seconds of a tick count in a time base. */
function at(ticks: number, timeBase: string): FrameRate {
  const base = rational(timeBase);
  return { numerator: ticks * base.numerator, denominator: base.denominator };
}

/** One fixture sample by file. */
function endSample(file: string): GridEndSample {
  const found = fixture.gridEnds.find((s) => s.file === file);
  if (!found) throw new Error(`no fixture sample ${file}`);
  return found;
}

/** The audio grid end of a fixture sample's last audio packet. */
function endOf(s: GridEndSample): FrameRate {
  return audioGridEnd({
    pts: s.lastAudioPts, duration: s.lastAudioDuration, timeBase: rational(s.audioTimeBase),
    discardPadding: s.discardPadding, sampleRate: s.sampleRate,
  });
}

/** The grid plan of a fixture sample. */
function gridOf(s: GridEndSample): ReturnType<typeof planFrameGrid> {
  return planFrameGrid({
    fps: rational(s.fps),
    firstVideoTime: at(s.firstVideoPts, s.videoTimeBase),
    lastVideoTime: at(s.lastVideoPts, s.videoTimeBase),
    sourceFrames: 2,
    firstAudioFrameTime: at(s.firstAudioFramePts, s.audioTimeBase),
    audioEnd: endOf(s),
    quantum: rational(s.quantum),
    singleFrameMs: 5000,
  });
}

/** Builds hand-written packets: [pts, dts, duration, "K" | "KD" | ""] in ticks. */
function packets(rows: [number | null, number | null, number, string][]): SourcePacket[] {
  return rows.map(([pts, dts, duration, flags]) => ({ pts, dts, duration, keyframe: flags.includes("K"), discard: flags.includes("D") }));
}

const MS = { numerator: 1, denominator: 1000 };
const ZERO = { numerator: 0, denominator: 1 };

describe("frame grid end and frame count (frame-grid design §4.1)", () => {
  it("GE01: an AAC MP4 ends at its last audio packet's end, not the decoded padded frame, and gets 60 frames", () => {
    const aac = endSample("round6/aac.mp4");
    expect(value(endOf(aac))).toBeCloseTo(2, 9);
    expect(gridOf(aac)).toMatchObject({ realFrameCount: 60, frameCount: 60, holdFrames: 0 });
  });

  it("GE01: a 2 s Opus WebM subtracts discard_padding and counts an end within one timestamp quantum of a slot boundary as on it", () => {
    const opus = endSample("round6/b_opus.webm");
    expect(opus.discardPadding).toBe(648);
    expect(value(endOf(opus))).toBeCloseTo(2.0005, 9);
    expect(gridOf(opus).frameCount).toBe(60);
  });

  it("GE01: past one quantum the end rounds up so the picture covers the last audio sample", () => {
    const grid = planFrameGrid({
      fps: { numerator: 30, denominator: 1 }, firstVideoTime: ZERO, lastVideoTime: { numerator: 59, denominator: 30 }, sourceFrames: 60,
      firstAudioFrameTime: ZERO, audioEnd: { numerator: 20015, denominator: 10000 }, quantum: MS, singleFrameMs: 5000,
    });
    expect(grid.frameCount).toBe(61);
  });

  it("GE01: 60 fps AC-3 and MP3 AVI take q = 0 and get 122 and 123 frames", () => {
    const ac3 = gridOf(endSample("round7/b_ac3.avi"));
    expect(ac3).toMatchObject({ realFrameCount: 60, frameCount: 122, holdFrames: 62 });
    const mp3 = gridOf(endSample("round7/a_libmp3lame.avi"));
    expect(mp3).toMatchObject({ realFrameCount: 122, frameCount: 123, holdFrames: 1 });
  });

  it("GE01: a multi-frame video without audio has no grid end and frameCount = V", () => {
    const grid = planFrameGrid({
      fps: { numerator: 30, denominator: 1 }, firstVideoTime: ZERO, lastVideoTime: { numerator: 59, denominator: 30 }, sourceFrames: 60,
      firstAudioFrameTime: null, audioEnd: null, quantum: ZERO, singleFrameMs: 5000,
    });
    expect(grid).toMatchObject({ gridEnd: null, realFrameCount: 60, frameCount: 60, holdFrames: 0 });
  });

  it("GE01: V rounds the last frame's slot to nearest, a half slot away from zero", () => {
    const grid = planFrameGrid({
      fps: { numerator: 2, denominator: 1 }, firstVideoTime: ZERO, lastVideoTime: { numerator: 1, denominator: 4 }, sourceFrames: 2,
      firstAudioFrameTime: null, audioEnd: null, quantum: ZERO, singleFrameMs: 5000,
    });
    expect(grid.realFrameCount).toBe(2);
  });

  it("GE02: the chain clones the last source frame before fps and cuts by frame number after it", () => {
    const chain = gridFilterChain({ gridStart: ZERO, fps: { numerator: 60, denominator: 1 }, startFrame: 0, endFrame: 120 });
    const parts = chain.split(",");
    const tpad = parts.indexOf("tpad=stop_mode=clone:stop=-1");
    const fps = parts.findIndex((p: string) => p.startsWith("fps="));
    const trim = parts.findIndex((p: string) => p.startsWith("trim="));
    expect(tpad).toBeGreaterThanOrEqual(0);
    expect(tpad).toBeLessThan(fps);
    expect(fps).toBeLessThan(trim);
    expect(parts[fps]).toBe("fps=60/1:start_time=0:round=near:eof_action=pass");
    expect(parts[trim]).toMatch(/^trim=(start_frame=0:)?end_frame=120$/);
  });

  it("GE02: a chunk cuts to its own grid range [k0, k1)", () => {
    const chain = gridFilterChain({ gridStart: ZERO, fps: { numerator: 30000, denominator: 1001 }, startFrame: 300, endFrame: 450 });
    expect(chain.split(",").at(-1)).toBe("trim=start_frame=300:end_frame=450");
  });

  it("GE03: the chain shifts time to the grid start first and starts fps at 0, so the last frame takes no extra slot", () => {
    const chain = gridFilterChain({ gridStart: { numerator: 1, denominator: 100 }, fps: { numerator: 30, denominator: 1 }, startFrame: 0, endFrame: 60 });
    const parts = chain.split(",");
    expect(parts[0]).toMatch(/^setpts=PTS-.+\/TB$/);
    const shift = parts[0]!.slice("setpts=PTS-".length, -"/TB".length).replace(/[()]/g, "");
    const [n, d] = shift.includes("/") ? shift.split("/").map(Number) : [Number(shift), 1];
    expect(n! / d!).toBeCloseTo(0.01, 12);
    expect(parts.find((p: string) => p.startsWith("fps="))).toContain(":start_time=0:");
  });

  it("GE04: the grid starts at the earlier of the first video frame and the first decoded audio frame", () => {
    // aac.mp4: the first audio packet is at -0.021333 s (encoder priming); the first decoded audio frame is at 0.
    const aac = endSample("round6/aac.mp4");
    expect(aac.firstAudioFramePts).toBe(0);
    expect(value(gridOf(aac).gridStart)).toBe(0);
    const early = planFrameGrid({
      fps: { numerator: 30, denominator: 1 }, firstVideoTime: { numerator: 1, denominator: 10 }, lastVideoTime: { numerator: 2, denominator: 1 }, sourceFrames: 58,
      firstAudioFrameTime: ZERO, audioEnd: { numerator: 2, denominator: 1 }, quantum: ZERO, singleFrameMs: 5000,
    });
    expect(value(early.gridStart)).toBe(0);
    expect(early.leadFrames).toBe(3);
    expect(early.realFrameCount).toBe(61);
  });

  it("GE05: a single-frame video lasts single_frame_duration_ms, or until a longer audio track ends with no quantum taken off", () => {
    const still = planFrameGrid({
      fps: { numerator: 25, denominator: 1 }, firstVideoTime: ZERO, lastVideoTime: ZERO, sourceFrames: 1,
      firstAudioFrameTime: null, audioEnd: null, quantum: ZERO, singleFrameMs: 5000,
    });
    expect(still).toMatchObject({ realFrameCount: 1, frameCount: 125, holdFrames: 124 });
    const withAudio = planFrameGrid({
      fps: { numerator: 25, denominator: 1 }, firstVideoTime: ZERO, lastVideoTime: ZERO, sourceFrames: 1,
      firstAudioFrameTime: ZERO, audioEnd: { numerator: 6, denominator: 1 }, quantum: MS, singleFrameMs: 5000,
    });
    expect(withAudio.frameCount).toBe(150);
  });

  it("GE06: grid end and frame count equal the round-8 reference output file by file", () => {
    expect(fixture.gridEnds).toHaveLength(26);
    const wrong = fixture.gridEnds
      .map((s) => {
        const grid = gridOf(s);
        return { file: s.file, end: grid.gridEnd === null ? Number.NaN : value(grid.gridEnd), V: grid.realFrameCount, frameCount: grid.frameCount };
      })
      .filter((r) => {
        const s = endSample(r.file);
        // The reference prints the end to six decimals.
        return !(Math.abs(r.end - Number(s.expectedGridEnd)) <= 1e-6) || r.V !== s.expectedV || r.frameCount !== s.expectedFrameCount;
      });
    expect(wrong).toEqual([]);
  });
});

describe("source keyframe statistics (frame-grid design §3.2 item 7, §7.16)", () => {
  it("N04: elst.mp4 counts the keyframe its edit list discards: earliest -0.36 s, largest interval 0.48 s", () => {
    const sample = fixture.keyframePackets["round11/seek/elst.mp4"]!;
    const stats = sourceKeyframeStats(packets(sample.packets), rational(sample.timeBase));
    expect(stats.earliestKeyframeTime).toBeCloseTo(-0.36, 9);
    expect(stats.maxKeyframeInterval).toBeCloseTo(0.48, 9);
    expect(stats.allKeyframes).toBe(false);
  });

  it("N04: vlate.mp4 starts its keyframes at 0.50 s", () => {
    const sample = fixture.keyframePackets["round11/seek/vlate.mp4"]!;
    const stats = sourceKeyframeStats(packets(sample.packets), rational(sample.timeBase));
    expect(stats.earliestKeyframeTime).toBeCloseTo(0.5, 9);
    expect(stats.maxKeyframeInterval).toBeCloseTo(0.48, 9);
  });

  it("N04: packets without pts are timed by dts", () => {
    // AVI H.264: no pts at all; keyframes every 10 frames at 1/25 s.
    const rows: [number | null, number | null, number, string][] = Array.from({ length: 30 }, (_u, i) => [null, i, 1, i % 10 === 0 ? "K" : ""]);
    const stats = sourceKeyframeStats(packets(rows), { numerator: 1, denominator: 25 });
    expect(stats.earliestKeyframeTime).toBe(0);
    expect(stats.maxKeyframeInterval).toBeCloseTo(0.4, 9);
  });

  it("N04: the last GOP up to the end of the last frame counts toward the largest interval", () => {
    const rows: [number | null, number | null, number, string][] = [
      [0, 0, 10, "K"], [10, 10, 10, ""], [20, 20, 10, "K"],
      ...Array.from({ length: 8 }, (_u, i): [number, number, number, string] => [30 + i * 10, 30 + i * 10, 10, ""]),
    ];
    // Keyframes 20 ticks apart; the last GOP runs from 20 to the end of the frame at 100, i.e. 110: 90 ticks.
    const stats = sourceKeyframeStats(packets(rows), { numerator: 1, denominator: 100 });
    expect(stats.maxKeyframeInterval).toBeCloseTo(0.9, 9);
  });

  it("N04: a source with one keyframe takes the whole duration", () => {
    const rows: [number | null, number | null, number, string][] = Array.from({ length: 50 }, (_u, i) => [i, i, 1, i === 0 ? "K" : ""]);
    const stats = sourceKeyframeStats(packets(rows), { numerator: 1, denominator: 25 });
    expect(stats.maxKeyframeInterval).toBeCloseTo(2, 9);
  });

  it("N04: an all-keyframe source is flagged", () => {
    const rows: [number | null, number | null, number, string][] = Array.from({ length: 5 }, (_u, i) => [i, i, 1, "K"]);
    expect(sourceKeyframeStats(packets(rows), { numerator: 1, denominator: 25 }).allKeyframes).toBe(true);
  });
});

describe("frame-number conversion (frame-grid design §7.16)", () => {
  const elst: SourceKeyframeStats = { earliestKeyframeTime: -0.36, maxKeyframeInterval: 0.48, allKeyframes: false };
  const grid25 = { fps: { numerator: 25, denominator: 1 }, gridStart: ZERO, realFrameCount: 105 };

  it("N01: grid frame i is at exactly i/fps", () => {
    expect(gridFrameTime(3, { numerator: 30000, denominator: 1001 })).toEqual({ numerator: 1001, denominator: 10000 });
    expect(gridFrameTime(0, { numerator: 30, denominator: 1 })).toEqual({ numerator: 0, denominator: 1 });
  });

  it("N02: a seek position before the earliest keyframe packet plus the largest keyframe interval gives no -ss", () => {
    // Threshold -0.36 + 0.48 = 0.12 s; frame 3 seeks to 2/25 = 0.08 s.
    expect(gridSeekPosition({ grid: grid25, keyframes: elst, startFrame: 3 }, 0)).toBeNull();
    // Frame 5 seeks to 4/25 = 0.16 s.
    expect(gridSeekPosition({ grid: grid25, keyframes: elst, startFrame: 5 }, 0)).toBeCloseTo(0.16, 9);
  });

  it("N02: keyframe intervals shorter than 3/23 s still use 3/23 s (FFmpeg CLI's B-frame seek back-off)", () => {
    // x50g5.avi: 50 fps, a keyframe every 5 frames (0.1 s); FFmpeg fails at 0.10 and 0.12 s and succeeds at 0.15 s.
    const x50g5 = { grid: { fps: { numerator: 50, denominator: 1 }, gridStart: ZERO, realFrameCount: 500 }, keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: 0.1, allKeyframes: false } };
    expect(gridSeekPosition({ ...x50g5, startFrame: 7 }, 0)).toBeNull();
    expect(gridSeekPosition({ ...x50g5, startFrame: 9 }, 0)).toBeCloseTo(0.16, 9);
  });

  it("N02: the seek frame is the target or the last real video frame (V - 1), whichever is earlier", () => {
    // V = 105: a hold-area target 150 seeks to frame 104, one frame early: 103/25 s.
    expect(gridSeekPosition({ grid: grid25, keyframes: elst, startFrame: 150 }, 0)).toBeCloseTo(103 / 25, 9);
  });

  it("N03: a late landing backs off from max(largest interval, 3/23 s), doubling each time, until decoding from the start", () => {
    const input = { grid: { ...grid25, realFrameCount: 2500 }, keyframes: elst, startFrame: 2000 };
    const pos = 1999 / 25;
    expect(gridSeekPosition(input, 0)).toBeCloseTo(pos, 9);
    expect(gridSeekPosition(input, 1)).toBeCloseTo(pos - 0.48, 9);
    expect(gridSeekPosition(input, 2)).toBeCloseTo(pos - 0.96, 9);
    expect(gridSeekPosition(input, 3)).toBeCloseTo(pos - 1.92, 9);
    // 2^8 x 0.48 = 122.88 s reaches before the threshold: no -ss.
    expect(gridSeekPosition(input, 9)).toBeNull();
  });

  it("N03: the back-off of a short-GOP source starts from 3/23 s", () => {
    const input = { grid: { fps: { numerator: 50, denominator: 1 }, gridStart: ZERO, realFrameCount: 500 }, keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: 0.1, allKeyframes: false }, startFrame: 400 };
    expect(gridSeekPosition(input, 1)).toBeCloseTo(399 / 50 - 3 / 23, 9);
    expect(gridSeekPosition(input, 2)).toBeCloseTo(399 / 50 - 6 / 23, 9);
  });

  it("N03: the landing check reads the first source frame before the fps filter", () => {
    const landing = { fps: { numerator: 25, denominator: 1 }, gridStart: ZERO, seekFrame: 40 };
    expect(gridLandingLate(landing, 1.6)).toBe(false); // slot 40
    expect(gridLandingLate(landing, 1.61)).toBe(false); // 40.25 rounds to slot 40
    expect(gridLandingLate(landing, 0.5)).toBe(false); // an earlier landing is fine
    expect(gridLandingLate(landing, 1.64)).toBe(true); // slot 41
    expect(gridLandingLate(landing, null)).toBe(true); // nothing decoded
  });

  it("N05: on a source starting at 1.467 s the seek and the landing are in absolute source time", () => {
    const ts = {
      grid: { fps: { numerator: 30, denominator: 1 }, gridStart: { numerator: 1467, denominator: 1000 }, realFrameCount: 300 },
      keyframes: { earliestKeyframeTime: 1.467, maxKeyframeInterval: 0.5, allKeyframes: false },
      startFrame: 30,
    };
    expect(gridSeekPosition(ts, 0)).toBeCloseTo(1.467 + 29 / 30, 9);
    const landing = { fps: ts.grid.fps, gridStart: ts.grid.gridStart, seekFrame: 30 };
    // -noaccurate_seek lands at 2.467 s: slot 30. Default accurate seek under -copyts adds the start time again: 3.867 s.
    expect(gridLandingLate(landing, 2.467)).toBe(false);
    expect(gridLandingLate(landing, 3.867)).toBe(true);
  });

  it("N06: the decode pre-roll of an original is max(largest keyframe interval, 3/23 s) x fps + 1", () => {
    expect(decodePrerollFrames({ toolSource: "original", keyframes: elst, fps: { numerator: 25, denominator: 1 } })).toBe(13);
    // 3/23 s at 23 fps is exactly 3 frames.
    expect(decodePrerollFrames({ toolSource: "original", keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: 0.04, allKeyframes: false }, fps: { numerator: 23, denominator: 1 } })).toBe(4);
  });

  it("N06: a non-integer pre-roll rounds up, never under the estimate", () => {
    // 3/23 s x 50 fps + 1 = 7.52 frames.
    expect(decodePrerollFrames({ toolSource: "original", keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: 0.1, allKeyframes: false }, fps: { numerator: 50, denominator: 1 } })).toBe(8);
  });

  it("N06: an edit file has no pre-roll", () => {
    expect(decodePrerollFrames({ toolSource: "edit", keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: 0.04, allKeyframes: true }, fps: { numerator: 25, denominator: 1 } })).toBe(0);
  });
});
