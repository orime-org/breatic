// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The compact presentation table and the planners that read it (inner#1306
 * test plan §75, T01–T10). Every time is an integer tick on the table's own
 * timescale; planners must answer from the runs without expanding frames.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as miniTools from "@shared/mini-tools/index.js";

interface Run { start: number; count: number; step: number; duration: number }
interface Table { schemaVersion: 1; timescale: number; runs: Run[] }
interface Rational { numerator: string; denominator: string }
interface PresentedFrame { displayStart: Rational; displayEnd: Rational }
interface FrameRequest { mode: "first" | "last" | "current" | "interval"; currentTime?: number; interval?: number }
interface FrameOutput { outputIndex: number; frameIndex: number; pts: number }
interface SegmentOutput { outputIndex: number; start: number; end: number }
interface TableApi {
  presentationTableSchema: { safeParse: (value: unknown) => { success: boolean } };
  projectPresentationTable: (frames: readonly PresentedFrame[]) => Table;
  presentationFrameCount: (table: Table) => number;
  presentationFrameAt: (table: Table, index: number) => { frameIndex: number; pts: number; displayEnd: number };
  presentationVideoEnd: (table: Table) => number;
  planVideoFrames: (table: Table, request: FrameRequest) => FrameOutput[];
  planVideoSplit: (table: Table, cuts: readonly number[]) => SegmentOutput[];
}

const api = miniTools as unknown as TableApi;

/**
 * A table of single-frame runs at the given tick starts, each lasting until the next start.
 * @param timescale - Ticks per second.
 * @param starts - Strictly increasing frame starts in ticks.
 * @param end - The last frame's end in ticks.
 * @returns The table.
 */
function table(timescale: number, starts: readonly number[], end: number): Table {
  return { schemaVersion: 1, timescale, runs: starts.map((start, index) => {
    const duration = (starts[index + 1] ?? end) - start;
    return { start, count: 1, step: duration, duration };
  }) };
}

/**
 * Every frame of a table as explicit ticks, for the naive reference planners.
 * @param source - The table.
 * @returns Each frame's start and end in ticks, in presentation order.
 */
function expand(source: Table): { start: number; end: number }[] {
  return source.runs.flatMap((run) => Array.from({ length: run.count }, (_, k) => ({ start: run.start + k * run.step, end: run.start + k * run.step + run.duration })));
}

/**
 * Naive covering frame: the last frame starting at or before the time, else the first.
 * @param starts - Frame starts in seconds.
 * @param time - The time in seconds.
 * @returns The covering frame index.
 */
function naiveCovering(starts: readonly number[], time: number): number {
  let found = 0;
  starts.forEach((start, index) => { if (start <= time) found = index; });
  return found;
}

/**
 * Naive frame planner over expanded frames.
 * @param source - The table.
 * @param request - The selection.
 * @returns The selected frames.
 */
function naiveFrames(source: Table, request: FrameRequest): FrameOutput[] {
  const frames = expand(source);
  const starts = frames.map((frame) => frame.start / source.timescale);
  const videoEnd = frames.at(-1)!.end / source.timescale;
  let picked: number[];
  if (request.mode === "first") picked = [0];
  else if (request.mode === "last") picked = [frames.length - 1];
  else if (request.mode === "current") picked = [naiveCovering(starts, request.currentTime!)];
  else {
    const set = new Set<number>();
    for (let k = 0; k * request.interval! < videoEnd; k += 1) {
      const sample = k * request.interval!;
      if (sample >= starts[0]!) set.add(naiveCovering(starts, sample));
    }
    picked = [...set].sort((a, b) => a - b);
  }
  return picked.map((frameIndex, outputIndex) => ({ outputIndex, frameIndex, pts: starts[frameIndex]! }));
}

/**
 * Naive split planner over expanded frames.
 * @param source - The table.
 * @param cuts - Cut times in seconds.
 * @returns All segments.
 */
function naiveSplit(source: Table, cuts: readonly number[]): SegmentOutput[] {
  const frames = expand(source);
  const starts = frames.map((frame) => frame.start / source.timescale);
  const videoEnd = frames.at(-1)!.end / source.timescale;
  const inner = [...new Set(cuts.filter((cut) => cut > starts[0]! && cut < videoEnd).map((cut) => starts[naiveCovering(starts, cut)]!))]
    .filter((start) => start > starts[0]!).sort((a, b) => a - b);
  const bounds = [starts[0]!, ...inner, videoEnd];
  return bounds.slice(0, -1).map((start, outputIndex) => ({ outputIndex, start, end: bounds[outputIndex + 1]! }));
}

const tableArbitrary: fc.Arbitrary<Table> = fc.record({
  timescale: fc.integer({ min: 1, max: 90_000 }),
  first: fc.integer({ min: 0, max: 1_000 }),
  runs: fc.array(fc.record({ count: fc.integer({ min: 1, max: 6 }), step: fc.integer({ min: 1, max: 50 }), shrink: fc.integer({ min: 0, max: 49 }), gap: fc.integer({ min: 0, max: 30 }) }), { minLength: 1, maxLength: 8 }),
}).map(({ timescale, first, runs }) => {
  let cursor = first;
  return { schemaVersion: 1 as const, timescale, runs: runs.map((run) => {
    const duration = Math.max(1, run.step - Math.min(run.shrink, run.step - 1));
    const step = run.count === 1 ? duration : run.step;
    const built = { start: cursor, count: run.count, step, duration };
    cursor += (run.count - 1) * step + duration + run.gap;
    return built;
  }) };
});

/**
 * A rational in lowest-terms-agnostic string form.
 * @param numerator - Numerator.
 * @param denominator - Denominator.
 * @returns The rational.
 */
const r = (numerator: number, denominator: number): Rational => ({ numerator: String(numerator), denominator: String(denominator) });

describe("T01–T03 projection of presented frames", () => {
  it("T01 round-trips every frame start and end exactly", () => {
    fc.assert(fc.property(tableArbitrary, (source) => {
      const frames = expand(source).map((frame) => ({ displayStart: r(frame.start, source.timescale), displayEnd: r(frame.end, source.timescale) }));
      const projected = api.projectPresentationTable(frames);
      expect(api.presentationFrameCount(projected)).toBe(frames.length);
      frames.forEach((frame, index) => {
        const at = api.presentationFrameAt(projected, index);
        expect(at.frameIndex).toBe(index);
        expect(at.pts).toBeCloseTo(Number(frame.displayStart.numerator) / Number(frame.displayStart.denominator), 12);
        expect(at.displayEnd).toBeCloseTo(Number(frame.displayEnd.numerator) / Number(frame.displayEnd.denominator), 12);
      });
    }));
  });

  it("T02 collapses a constant frame rate into one run and emits canonical runs", () => {
    const frames = Array.from({ length: 300 }, (_, index) => ({ displayStart: r(index * 1001, 30_000), displayEnd: r((index + 1) * 1001, 30_000) }));
    expect(api.projectPresentationTable(frames).runs).toHaveLength(1);
    fc.assert(fc.property(tableArbitrary, (source) => {
      const projected = api.projectPresentationTable(expand(source).map((frame) => ({ displayStart: r(frame.start, source.timescale), displayEnd: r(frame.end, source.timescale) })));
      projected.runs.slice(1).forEach((run, index) => {
        const previous = projected.runs[index]!;
        const continues = previous.start + previous.count * previous.step === run.start;
        expect(continues && previous.step === run.step && previous.duration === run.duration && (run.count > 1 || run.step === run.duration)).toBe(false);
      });
    }));
  });

  it.each([
    ["no frames", []],
    ["a start that does not increase", [{ displayStart: r(1, 10), displayEnd: r(2, 10) }, { displayStart: r(1, 10), displayEnd: r(3, 10) }]],
    ["an end not after its start", [{ displayStart: r(1, 10), displayEnd: r(1, 10) }]],
    ["a negative start", [{ displayStart: r(-1, 10), displayEnd: r(1, 10) }]],
    ["an overlap with the next frame", [{ displayStart: r(0, 10), displayEnd: r(3, 10) }, { displayStart: r(2, 10), displayEnd: r(4, 10) }]],
    ["ticks beyond the safe integer range", [{ displayStart: { numerator: "0", denominator: "1" }, displayEnd: { numerator: "1", denominator: "9007199254740993" } }, { displayStart: { numerator: "1", denominator: "9007199254740991" }, displayEnd: { numerator: "2", denominator: "9007199254740991" } }]],
  ] as const)("T03 rejects %s", (_name, frames) => {
    expect(api.projectPresentationTable).toBeTypeOf("function");
    expect(() => api.projectPresentationTable(frames)).toThrow();
  });
});

describe("T04 schema", () => {
  const valid: Table = { schemaVersion: 1, timescale: 1000, runs: [{ start: 0, count: 3, step: 40, duration: 40 }, { start: 200, count: 1, step: 40, duration: 40 }] };

  it("accepts a valid table", () => {
    expect(api.presentationTableSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    ["a zero timescale", { ...valid, timescale: 0 }],
    ["a fractional timescale", { ...valid, timescale: 1.5 }],
    ["no runs", { ...valid, runs: [] }],
    ["a zero count", { ...valid, runs: [{ start: 0, count: 0, step: 40, duration: 40 }] }],
    ["a zero duration", { ...valid, runs: [{ start: 0, count: 1, step: 0, duration: 0 }] }],
    ["a duration longer than the step", { ...valid, runs: [{ start: 0, count: 2, step: 40, duration: 41 }] }],
    ["a single frame whose step differs from its duration", { ...valid, runs: [{ start: 0, count: 1, step: 80, duration: 40 }] }],
    ["a negative start", { ...valid, runs: [{ start: -1, count: 1, step: 40, duration: 40 }] }],
    ["a run starting before the previous run ends", { ...valid, runs: [{ start: 0, count: 3, step: 40, duration: 40 }, { start: 100, count: 1, step: 40, duration: 40 }] }],
    ["an unsafe tick", { ...valid, runs: [{ start: 0, count: 2, step: Number.MAX_SAFE_INTEGER, duration: 1 }] }],
    ["an unknown field", { ...valid, extra: true }],
  ] as const)("T04 rejects %s", (_name, value) => {
    expect(api.presentationTableSchema.safeParse(value).success).toBe(false);
  });
});

describe("T05–T07 frame selection", () => {
  const source = table(100, [0, 4, 12, 20], 28);

  it("T05 finds the covering frame like the naive search, bounded by the first and last frames", () => {
    fc.assert(fc.property(tableArbitrary, fc.double({ min: -1, max: 2_000, noNaN: true }), (shape, seconds) => {
      const time = Math.max(0, seconds);
      expect(api.planVideoFrames(shape, { mode: "current", currentTime: time })).toEqual(naiveFrames(shape, { mode: "current", currentTime: time }));
    }));
  });

  it.each([
    [{ mode: "first" }, [{ outputIndex: 0, frameIndex: 0, pts: 0 }]],
    [{ mode: "last" }, [{ outputIndex: 0, frameIndex: 3, pts: 0.2 }]],
    [{ mode: "current", currentTime: 0.13 }, [{ outputIndex: 0, frameIndex: 2, pts: 0.12 }]],
    [{ mode: "current", currentTime: 0.12 }, [{ outputIndex: 0, frameIndex: 2, pts: 0.12 }]],
    [{ mode: "current", currentTime: 0.119 }, [{ outputIndex: 0, frameIndex: 1, pts: 0.04 }]],
    [{ mode: "interval", interval: 0.05 }, [{ outputIndex: 0, frameIndex: 0, pts: 0 }, { outputIndex: 1, frameIndex: 1, pts: 0.04 }, { outputIndex: 2, frameIndex: 2, pts: 0.12 }, { outputIndex: 3, frameIndex: 3, pts: 0.2 }]],
    [{ mode: "interval", interval: 0.001 }, [{ outputIndex: 0, frameIndex: 0, pts: 0 }, { outputIndex: 1, frameIndex: 1, pts: 0.04 }, { outputIndex: 2, frameIndex: 2, pts: 0.12 }, { outputIndex: 3, frameIndex: 3, pts: 0.2 }]],
  ] as const)("T06 selects %j", (request, expected) => {
    expect(api.planVideoFrames(source, request)).toEqual(expected);
  });

  it("T06 keeps a leading empty edit: the first frame starts after zero", () => {
    const shifted = table(100, [4, 12, 20], 28);
    expect(api.planVideoFrames(shifted, { mode: "first" })).toEqual([{ outputIndex: 0, frameIndex: 0, pts: 0.04 }]);
    expect(api.planVideoFrames(shifted, { mode: "current", currentTime: 0 })).toEqual([{ outputIndex: 0, frameIndex: 0, pts: 0.04 }]);
  });

  it("T06 rejects current and interval modes without their values", () => {
    expect(api.planVideoFrames(source, { mode: "first" })).toEqual([{ outputIndex: 0, frameIndex: 0, pts: 0 }]);
    expect(() => api.planVideoFrames(source, { mode: "current" })).toThrow();
    expect(() => api.planVideoFrames(source, { mode: "interval" })).toThrow();
  });

  it("T07 matches the naive planner for every mode", () => {
    const request = fc.oneof(
      fc.constant<FrameRequest>({ mode: "first" }),
      fc.constant<FrameRequest>({ mode: "last" }),
      fc.double({ min: 0, max: 2_000, noNaN: true }).map((currentTime): FrameRequest => ({ mode: "current", currentTime })),
      fc.double({ min: 0.0005, max: 5, noNaN: true }).map((interval): FrameRequest => ({ mode: "interval", interval })),
    );
    fc.assert(fc.property(tableArbitrary, request, (shape, selection) => {
      expect(api.planVideoFrames(shape, selection)).toEqual(naiveFrames(shape, selection));
    }));
  });
});

describe("T08–T09 split", () => {
  const source = table(100, [0, 4, 12, 20], 28);

  it("T08 snaps cuts to covering frame starts and returns all N plus one segments", () => {
    expect(api.planVideoSplit(source, [0.12, 0, 0.05, 0.12, 0.28])).toEqual([
      { outputIndex: 0, start: 0, end: 0.04 },
      { outputIndex: 1, start: 0.04, end: 0.12 },
      { outputIndex: 2, start: 0.12, end: 0.28 },
    ]);
  });

  it("T08 keeps the whole video when there is no internal cut, starting at the first frame", () => {
    expect(api.planVideoSplit(source, [])).toEqual([{ outputIndex: 0, start: 0, end: 0.28 }]);
    expect(api.planVideoSplit(table(100, [4, 12], 20), [0.01])).toEqual([{ outputIndex: 0, start: 0.04, end: 0.2 }]);
  });

  it("T08 is unchanged under permutations of the cuts", () => {
    const cuts = [0, 0.04, 0.12, 0.12, 0.28];
    const expected = api.planVideoSplit(source, cuts);
    fc.assert(fc.property(fc.shuffledSubarray(cuts, { minLength: cuts.length, maxLength: cuts.length }), (permutation) => {
      expect(api.planVideoSplit(source, permutation)).toEqual(expected);
    }));
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.29])("T08 rejects the cut %s", (cut) => {
    expect(api.planVideoSplit(source, [])).toEqual([{ outputIndex: 0, start: 0, end: 0.28 }]);
    expect(() => api.planVideoSplit(source, [cut])).toThrow();
  });

  it("T09 matches the naive planner and covers the first start to the video end", () => {
    fc.assert(fc.property(tableArbitrary, fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { maxLength: 6 }), (shape, fractions) => {
      const end = api.presentationVideoEnd(shape);
      const cuts = fractions.map((fraction) => fraction * end);
      const segments = api.planVideoSplit(shape, cuts);
      expect(segments).toEqual(naiveSplit(shape, cuts));
      expect(segments[0]!.start).toBe(api.presentationFrameAt(shape, 0).pts);
      expect(segments.at(-1)!.end).toBe(end);
      segments.slice(1).forEach((segment, index) => expect(segment.start).toBe(segments[index]!.end));
    }));
  });
});

describe("T10 no expansion", () => {
  it("answers a billion-frame table within 50 ms", () => {
    const huge: Table = { schemaVersion: 1, timescale: 30_000, runs: [{ start: 0, count: 1_000_000_000, step: 1001, duration: 1001 }] };
    const begun = performance.now();
    expect(api.planVideoFrames(huge, { mode: "first" })).toEqual([{ outputIndex: 0, frameIndex: 0, pts: 0 }]);
    expect(api.planVideoFrames(huge, { mode: "last" })[0]!.frameIndex).toBe(999_999_999);
    expect(api.planVideoFrames(huge, { mode: "current", currentTime: 1001 })[0]!.frameIndex).toBe(30_000);
    expect(api.planVideoSplit(huge, [1001, 2002])).toHaveLength(3);
    expect(performance.now() - begun).toBeLessThan(50);
  });
});
