// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { planEditListPresentation, type ExactPresentationTime, type EditListPresentationInput } from "@ingest/container/iso-bmff-presentation.js";

/** Encode an explicit independently derived rational expectation without rounding.
 * @throws {never} Never.
 */
function time(numerator: string | number, denominator: string | number = 1): ExactPresentationTime { return { numerator: String(numerator), denominator: String(denominator) }; }

const FRAMES = Array.from({ length: 17 }, (_, index) => ({ rawDecodeOrdinal: index, ptsTicks: String(4096 + index * 2048) }));
const EDIT = { segmentDurationMovieTicks: "1000", mediaTimeTrackTicks: "4096", mediaRateFixed16_16: "65536" };
const INPUT: EditListPresentationInput = { movieTimescale: "1000", mediaTimescale: "16384", sourceTimeBase: time(1, 16384), edits: [EDIT], frames: FRAMES };
const EIGHT = [time(0), time(1, 8), time(1, 4), time(3, 8), time(1, 2), time(5, 8), time(3, 4), time(7, 8), time(1)];
const SIXTEENTHS = [time(1, 16), time(3, 16), time(5, 16), time(7, 16), time(9, 16), time(11, 16), time(13, 16), time(15, 16)];

describe("owned rate-one presentation occurrences from a complete physical ledger", () => {
  it("clips an explicit single-tail edit to its eight legal frame identities", () => {
    const actual = planEditListPresentation(INPUT, 32);
    expect(actual.edits).toEqual([{ editOccurrence: 0, empty: false, start: time(0), end: time(1) }]);
    expect(actual.frames).toEqual(FRAMES.slice(0, 8).map((frame, index) => ({ presentationOrdinal: index, editOccurrence: 0, rawDecodeOrdinal: frame.rawDecodeOrdinal, sourcePtsTicks: frame.ptsTicks, mappedPts: EIGHT[index], displayStart: EIGHT[index], displayEnd: EIGHT[index + 1] })));
  });
  it("keeps a partially overlapping first picture with mapped PTS distinct from clipped display start", () => {
    const actual = planEditListPresentation({ ...INPUT, edits: [{ ...EDIT, mediaTimeTrackTicks: "5120" }] }, 32);
    expect(actual.frames.map((frame) => frame.rawDecodeOrdinal)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(actual.frames.map((frame) => frame.mappedPts)).toEqual([time(-1, 16), ...SIXTEENTHS]);
    expect(actual.frames.map((frame) => frame.displayStart)).toEqual([time(0), ...SIXTEENTHS]);
    expect(actual.frames.map((frame) => frame.displayEnd)).toEqual([...SIXTEENTHS, time(1)]);
    expect(actual.frames[0]).toMatchObject({ sourcePtsTicks: "4096", rawDecodeOrdinal: 0, mappedPts: time(-1, 16), displayStart: time(0) });
  });
  it("excludes earlier decoder dependencies that do not overlap the edit", () => {
    const actual = planEditListPresentation({ ...INPUT, edits: [{ ...EDIT, mediaTimeTrackTicks: "12288" }] }, 32);
    expect(actual.frames.map((frame) => frame.rawDecodeOrdinal)).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
    expect(actual.frames.map((frame) => frame.displayStart)).toEqual(EIGHT.slice(0, 8));
  });
  it("retains empty movie intervals and positive first PTS without an invented zero-point shift", () => {
    const actual = planEditListPresentation({ ...INPUT, edits: [{ ...EDIT, segmentDurationMovieTicks: "250", mediaTimeTrackTicks: "-1" }, EDIT] }, 32);
    expect(actual.edits).toEqual([{ editOccurrence: 0, empty: true, start: time(0), end: time(1, 4) }, { editOccurrence: 1, empty: false, start: time(1, 4), end: time(5, 4) }]);
    expect(actual.frames).toHaveLength(8);
    expect(actual.frames[0]).toMatchObject({ presentationOrdinal: 0, editOccurrence: 1, rawDecodeOrdinal: 0, mappedPts: time(1, 4), displayStart: time(1, 4) });
    expect(actual.frames.at(-1)!.displayEnd).toEqual(time(5, 4));
  });
  it("maps multiple nonempty edits to exact movie time instead of inheriting demuxer drift", () => {
    const actual = planEditListPresentation({ ...INPUT, edits: [{ ...EDIT, segmentDurationMovieTicks: "500" }, { ...EDIT, segmentDurationMovieTicks: "500", mediaTimeTrackTicks: "20480" }] }, 32);
    expect(actual.frames.map((frame) => frame.rawDecodeOrdinal)).toEqual([0, 1, 2, 3, 8, 9, 10, 11]);
    expect(actual.frames.map((frame) => frame.displayStart)).toEqual(EIGHT.slice(0, 8));
    expect(actual.frames.map((frame) => frame.displayEnd)).toEqual(EIGHT.slice(1));
  });
  it("uses distinct presentation ordinals when the same raw frames occur twice", () => {
    const edit = { ...EDIT, segmentDurationMovieTicks: "500" };
    const actual = planEditListPresentation({ ...INPUT, edits: [edit, edit] }, 32);
    expect(actual.frames.map((frame) => frame.rawDecodeOrdinal)).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
    expect(actual.frames.map((frame) => frame.presentationOrdinal)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(actual.frames.map((frame) => frame.editOccurrence)).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    expect(actual.frames.map((frame) => frame.displayStart)).toEqual(EIGHT.slice(0, 8));
    expect(actual.frames[0]!.sourcePtsTicks).toBe(actual.frames[4]!.sourcePtsTicks);
  });
  it("handles a later edit jumping backward without reordering source identities or duplicating movie PTS", () => {
    const actual = planEditListPresentation({ ...INPUT, edits: [{ ...EDIT, segmentDurationMovieTicks: "500", mediaTimeTrackTicks: "20480" }, { ...EDIT, segmentDurationMovieTicks: "500" }] }, 32);
    expect(actual.frames.map((frame) => frame.rawDecodeOrdinal)).toEqual([8, 9, 10, 11, 0, 1, 2, 3]);
    expect(actual.frames.map((frame) => frame.displayStart)).toEqual(EIGHT.slice(0, 8));
  });
  it("keeps the source time-base numerator when it differs from one", () => {
    const frames = FRAMES.map((frame) => ({ ...frame, ptsTicks: String(BigInt(frame.ptsTicks) / 2n) }));
    const actual = planEditListPresentation({ ...INPUT, sourceTimeBase: time(2, 16384), frames }, 32);
    expect(actual.frames.map((frame) => frame.displayStart)).toEqual(EIGHT.slice(0, 8));
    expect(actual.frames[0]!.sourcePtsTicks).toBe("2048");
  });
  it("clips a final partial frame at the explicit edit boundary", () => {
    const actual = planEditListPresentation({ ...INPUT, movieTimescale: "16000", edits: [EDIT] }, 32);
    expect(actual.frames).toHaveLength(1);
    expect(actual.frames[0]).toMatchObject({ rawDecodeOrdinal: 0, displayStart: time(0), displayEnd: time(1, 16) });
  });
  it("preserves negative physical source ticks when their picture overlaps the legal start", () => {
    const actual = planEditListPresentation({ ...INPUT, edits: [{ ...EDIT, mediaTimeTrackTicks: "0" }], frames: [{ rawDecodeOrdinal: 0, ptsTicks: "-1024" }, { rawDecodeOrdinal: 1, ptsTicks: "1024" }, { rawDecodeOrdinal: 2, ptsTicks: "2048" }] }, 32);
    expect(actual.frames[0]).toMatchObject({ rawDecodeOrdinal: 0, sourcePtsTicks: "-1024", mappedPts: time(-1, 16), displayStart: time(0), displayEnd: time(1, 16) });
  });
  it("uses the explicit edit end for the last held picture instead of guessing fps or packet duration", () => {
    const actual = planEditListPresentation({ ...INPUT, movieTimescale: "1", mediaTimescale: "1", sourceTimeBase: time(1), frames: [{ rawDecodeOrdinal: 0, ptsTicks: "0" }, { rawDecodeOrdinal: 1, ptsTicks: "3" }], edits: [{ ...EDIT, segmentDurationMovieTicks: "5", mediaTimeTrackTicks: "0" }] }, 32);
    expect(actual.frames.map((frame) => [frame.displayStart, frame.displayEnd])).toEqual([[time(0), time(3)], [time(3), time(5)]]);
  });
  it("does not fabricate a frame before the physical ledger's first picture", () => {
    const actual = planEditListPresentation({ ...INPUT, edits: [{ ...EDIT, segmentDurationMovieTicks: "125", mediaTimeTrackTicks: "0" }] }, 32);
    expect(actual.frames).toEqual([]);
  });
  it("preserves timestamps beyond the safe Number range without collapsing adjacent frames", () => {
    const start = 9007199254740993n;
    const actual = planEditListPresentation({ ...INPUT, movieTimescale: "1", mediaTimescale: "1", sourceTimeBase: time(1), frames: [{ rawDecodeOrdinal: 0, ptsTicks: start.toString() }, { rawDecodeOrdinal: 1, ptsTicks: (start + 1n).toString() }], edits: [{ ...EDIT, segmentDurationMovieTicks: "2", mediaTimeTrackTicks: start.toString() }] }, 32);
    expect(actual.frames.map((frame) => frame.mappedPts)).toEqual([time(0), time(1)]);
    expect(actual.frames.map((frame) => frame.sourcePtsTicks)).toEqual(["9007199254740993", "9007199254740994"]);
  });
  it("limits repeated-edit expansion independently of physical frame count", () => {
    expect(() => planEditListPresentation({ ...INPUT, edits: [EDIT, EDIT] }, 8)).toThrowError(expect.objectContaining({ code: "resource_limit" }));
  });
  it("rejects an invalid occurrence ceiling before projecting data", () => {
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) expect(() => planEditListPresentation(INPUT, invalid)).toThrowError(expect.objectContaining({ code: "invalid_limits" }));
  });
  it("rejects unknown or zero clock divisors without constructing guessed frame times", () => {
    for (const input of [{ ...INPUT, movieTimescale: "0" }, { ...INPUT, mediaTimescale: "0" }, { ...INPUT, sourceTimeBase: time(1, 0) }, { ...INPUT, sourceTimeBase: time(0, 1) }]) expect(() => planEditListPresentation(input, 32)).toThrowError(expect.objectContaining({ code: "invalid_clock" }));
  });
  it("rejects a zero or negative source edit rate", () => {
    for (const rate of ["0", "-65536"]) expect(() => planEditListPresentation({ ...INPUT, edits: [{ ...EDIT, mediaRateFixed16_16: rate }] }, 32)).toThrowError(expect.objectContaining({ code: "unsupported_rate" }));
  });
  it("rejects invalid negative media-time edits while retaining separate empty-edit semantics", () => {
    expect(() => planEditListPresentation({ ...INPUT, edits: [{ ...EDIT, mediaTimeTrackTicks: "-2" }] }, 32)).toThrowError(expect.objectContaining({ code: "invalid_edit" }));
  });
  it("rejects ambiguous or incomplete raw ordinal identity", () => {
    for (const frames of [[{ rawDecodeOrdinal: 1, ptsTicks: "0" }], [{ rawDecodeOrdinal: 0, ptsTicks: "0" }, { rawDecodeOrdinal: 0, ptsTicks: "1" }]]) expect(() => planEditListPresentation({ ...INPUT, frames }, 32)).toThrowError(expect.objectContaining({ code: "invalid_ledger" }));
  });
  it("rejects duplicate or decreasing source CTS without sorting away identity", () => {
    for (const frames of [[{ rawDecodeOrdinal: 0, ptsTicks: "1" }, { rawDecodeOrdinal: 1, ptsTicks: "1" }], [{ rawDecodeOrdinal: 0, ptsTicks: "1" }, { rawDecodeOrdinal: 1, ptsTicks: "0" }]]) expect(() => planEditListPresentation({ ...INPUT, frames }, 32)).toThrowError(expect.objectContaining({ code: "invalid_ledger" }));
  });
  it("never mutates the frozen caller's source clocks or edit identities", () => {
    const input = structuredClone(INPUT); const before = structuredClone(input);
    planEditListPresentation(input, 32);
    expect(input).toEqual(before);
  });
  it("keeps stable raw identity and exact contiguous movie intervals for arbitrary repeated schedules", () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: 50 }), { minLength: 1, maxLength: 16 }), fc.integer({ min: 1, max: 4 }), (gaps, repetitions) => {
      let point = 0; const frames = gaps.map((gap, rawDecodeOrdinal) => { const frame = { rawDecodeOrdinal, ptsTicks: String(point) }; point += gap; return frame; });
      const duration = point; const edit = { ...EDIT, segmentDurationMovieTicks: String(duration), mediaTimeTrackTicks: "0" };
      const result = planEditListPresentation({ ...INPUT, movieTimescale: "1", mediaTimescale: "1", sourceTimeBase: time(1), frames, edits: Array.from({ length: repetitions }, () => edit) }, 1000);
      expect(result.frames).toHaveLength(frames.length * repetitions);
      for (const [index, frame] of result.frames.entries()) {
        expect(frame.presentationOrdinal).toBe(index); expect(frame.rawDecodeOrdinal).toBe(index % frames.length); expect(frame.sourcePtsTicks).toBe(frames[index % frames.length]!.ptsTicks);
        expect(frame.displayStart.denominator).toBe("1"); expect(frame.displayEnd.denominator).toBe("1"); expect(BigInt(frame.displayStart.numerator)).toBeLessThan(BigInt(frame.displayEnd.numerator));
        if (index > 0) expect(result.frames[index - 1]!.displayEnd).toEqual(frame.displayStart);
      }
      expect(result.frames.at(-1)!.displayEnd).toEqual(time(duration * repetitions));
    }), { numRuns: 40 });
  });
  it("is invariant under arbitrary large physical source translations", () => {
    fc.assert(fc.property(fc.bigInt({ min: 9007199254740993n, max: 9223372036854775000n }), (shift) => {
      const base: EditListPresentationInput = { movieTimescale: "1", mediaTimescale: "1", sourceTimeBase: time(1), frames: [{ rawDecodeOrdinal: 0, ptsTicks: "0" }, { rawDecodeOrdinal: 1, ptsTicks: "1" }], edits: [{ ...EDIT, segmentDurationMovieTicks: "2", mediaTimeTrackTicks: "0" }] };
      const shifted = { ...base, frames: base.frames.map((frame) => ({ ...frame, ptsTicks: (BigInt(frame.ptsTicks) + shift).toString() })), edits: [{ ...base.edits[0]!, mediaTimeTrackTicks: shift.toString() }] };
      expect(planEditListPresentation(shifted, 8).frames.map(({ mappedPts, displayStart, displayEnd }) => ({ mappedPts, displayStart, displayEnd }))).toEqual(planEditListPresentation(base, 8).frames.map(({ mappedPts, displayStart, displayEnd }) => ({ mappedPts, displayStart, displayEnd })));
    }), { numRuns: 40 });
  });
});
