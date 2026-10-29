// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Producer of the stored source ledger v2 and its compact presentation table
 * (inner#1306 test plan §76, A cases). Both objects come from one pure call
 * over the facts the container already parses; the compact table equals the
 * S1 projection of the presented frames and is the ledger's own presentation.
 */

import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as assembly from "@ingest/container/assemble-video-source-ledger.js";
import { assembleExplicitIsoVideoPresentation } from "@ingest/container/explicit-iso-video-presentation.js";
import type { IsoBmffEdit, IsoBmffMetadata } from "@ingest/container/iso-bmff-metadata.js";
import type { MatroskaMetadata } from "@ingest/container/matroska-metadata.js";
import type { MatroskaPhysicalVideoProbe, PhysicalVideoProbe } from "@ingest/container/physical-video-probe.js";
import { presentationTableSchema, projectPresentationTable, type VideoPresentationTable } from "@shared/mini-tools/video-presentation-table.js";
import * as sharedLedger from "@shared/upload/video-source-ledger.js";
import { ORIGINAL_ISO_ASSEMBLY_FIXTURES } from "./helpers/source-ledger-assembly-fixtures.js";
import { MATROSKA_PRESENTATION_CASES } from "./helpers/matroska-presentation-fixtures.js";

interface Rational { numerator: string; denominator: string }
interface EditSpan { sourceStart: Rational; sourceEnd: Rational; presentationStart: Rational; rate: Rational }
interface SourceRun { start: number; count: number; step: number }
interface LedgerV2 {
  schemaVersion: 2;
  sourceFingerprint: string;
  producerVersion: 2;
  attempt: { jobId: string; deadlineAt: number };
  presentation: VideoPresentationTable;
  source: { timeBase: Rational; runs: SourceRun[] };
  videoEdits: EditSpan[] | null;
  audioEdits: EditSpan[] | null;
}
interface Identity { sourceFingerprint: string; attempt: { jobId: string; deadlineAt: number } }
type IsoInput = Identity & { kind: "iso_bmff"; metadata: IsoBmffMetadata; physical: PhysicalVideoProbe; audioTrackId: number | null };
type MatroskaInput = Identity & { kind: "matroska"; metadata: MatroskaMetadata; physical: MatroskaPhysicalVideoProbe };
type Assemble = (input: IsoInput | MatroskaInput) => { ledger: LedgerV2; table: VideoPresentationTable };

const IDENTITY: Identity = { sourceFingerprint: "a".repeat(64), attempt: { jobId: "accepted-job", deadlineAt: 1 } };

afterEach(() => vi.restoreAllMocks());

/**
 * The v2 producer, failing when it does not exist yet.
 * @returns The producer.
 * @throws {Error} When it is not exported.
 */
function assemble(): Assemble {
  const value = (assembly as unknown as { assembleVideoSourceLedgerV2?: Assemble }).assembleVideoSourceLedgerV2;
  expect(value, "assembleVideoSourceLedgerV2 is exported").toBeTypeOf("function");
  return value!;
}

/**
 * The shared v2 ledger schema, failing when it does not exist yet.
 * @returns The schema's parse.
 * @throws {Error} When it is not exported.
 */
function ledgerSchema(): (value: unknown) => LedgerV2 {
  const schema = (sharedLedger as unknown as { videoSourceLedgerV2Schema?: { parse: (value: unknown) => LedgerV2 } }).videoSourceLedgerV2Schema;
  expect(schema, "videoSourceLedgerV2Schema is exported").toBeDefined();
  return (value) => schema!.parse(value);
}

/**
 * An exact rational literal.
 * @param numerator - The numerator.
 * @param denominator - The denominator.
 * @returns The rational.
 */
function r(numerator: number | bigint, denominator: number | bigint = 1): Rational {
  return { numerator: String(numerator), denominator: String(denominator) };
}

/**
 * A rate-agnostic span literal.
 * @param sourceStart - Source start.
 * @param sourceEnd - Source end.
 * @param presentationStart - Presentation start.
 * @param rate - Rate.
 * @returns The span.
 */
function span(sourceStart: Rational, sourceEnd: Rational, presentationStart: Rational, rate: Rational = r(1)): EditSpan {
  return { sourceStart, sourceEnd, presentationStart, rate };
}

/**
 * Expand source runs into per-frame ticks.
 * @param runs - Source runs.
 * @returns One tick per presented frame.
 */
function expandSource(runs: readonly SourceRun[]): number[] {
  return runs.flatMap((run) => Array.from({ length: run.count }, (_, k) => run.start + k * run.step));
}

/**
 * Expand a compact table into per-frame tick intervals.
 * @param table - The table.
 * @returns Each frame's start and end tick.
 */
function expandTable(table: VideoPresentationTable): { start: number; end: number }[] {
  return table.runs.flatMap((run) => Array.from({ length: run.count }, (_, k) => ({ start: run.start + k * run.step, end: run.start + k * run.step + run.duration })));
}

/**
 * Greedy canonical source runs: a frame extends the last run when it continues its progression, or the last run has one frame and the tick increases; a single-frame run has step 0.
 * @param ticks - Per-frame source ticks.
 * @returns The canonical runs.
 */
function encodeSource(ticks: readonly number[]): SourceRun[] {
  const runs: SourceRun[] = [];
  for (const tick of ticks) {
    const run = runs.at(-1);
    if (run !== undefined && run.count === 1 && tick > run.start) { run.step = tick - run.start; run.count = 2; } else if (run !== undefined && run.count > 1 && tick === run.start + run.count * run.step) run.count += 1;
    else runs.push({ start: tick, count: 1, step: 0 });
  }
  return runs;
}

/**
 * Reduce an integer fraction.
 * @param numerator - The numerator.
 * @param denominator - A positive denominator.
 * @returns The reduced rational.
 */
function reduce(numerator: bigint, denominator: bigint): Rational {
  let a = numerator < 0n ? -numerator : numerator;
  let b = denominator;
  while (b !== 0n) [a, b] = [b, a % b];
  return a === 0n ? r(0) : r(numerator / a, denominator / a);
}

/**
 * Reference spans of an ISO edit list: non-empty, non-zero edits only, laid out in movie time.
 * @param edits - The track's edit list.
 * @param movieTimescale - Movie ticks per second.
 * @param mediaTimescale - The track's media ticks per second.
 * @returns The expected spans.
 */
function spansOf(edits: readonly IsoBmffEdit[], movieTimescale: string, mediaTimescale: string): EditSpan[] {
  const movie = BigInt(movieTimescale);
  const media = BigInt(mediaTimescale);
  let at = 0n;
  const spans: EditSpan[] = [];
  for (const edit of edits) {
    const duration = BigInt(edit.segmentDurationMovieTicks);
    const mediaTime = BigInt(edit.mediaTimeTrackTicks);
    const rate = BigInt(edit.mediaRateFixed16_16);
    if (mediaTime !== -1n && duration > 0n) {
      // source end = mediaTime / media + duration / movie × rate / 65536
      spans.push(span(reduce(mediaTime, media), reduce(mediaTime * movie * 65536n + duration * rate * media, media * movie * 65536n), reduce(at, movie), reduce(rate, 65536n)));
    }
    at += duration;
  }
  return spans;
}

/**
 * An ISO input from an original assembly fixture.
 * @param id - Fixture id.
 * @param audioTrackId - The selected audio track, if any.
 * @returns A fresh input.
 */
function isoFixture(id: string, audioTrackId: number | null = null): IsoInput {
  const fixture = ORIGINAL_ISO_ASSEMBLY_FIXTURES.find((entry) => entry.id === id)!;
  return { ...structuredClone(IDENTITY), kind: "iso_bmff", metadata: structuredClone(fixture.metadata), physical: structuredClone(fixture.physical), audioTrackId };
}

/**
 * A Matroska input from an original presentation fixture.
 * @param id - Fixture id.
 * @returns A fresh input.
 */
function matroskaFixture(id: string): MatroskaInput {
  const fixture = MATROSKA_PRESENTATION_CASES.find((entry) => entry.id === id)!;
  return { ...structuredClone(IDENTITY), kind: "matroska", metadata: structuredClone(fixture.metadata), physical: structuredClone(fixture.physical) };
}

/**
 * A one-edit ISO source on a millisecond clock with frames every 40 ms.
 * @param rate - The 16.16 fixed edit rate.
 * @param duration - Segment duration in movie milliseconds.
 * @param mediaTime - Edit media start in milliseconds.
 * @param count - Physical frame count.
 * @returns A fresh input.
 */
function rated(rate: string, duration: string, mediaTime: string, count = 11): IsoInput {
  return {
    ...structuredClone(IDENTITY), kind: "iso_bmff", audioTrackId: null,
    metadata: { movieTimescale: "1000", movieDurationTicks: duration, tracks: [{ trackId: 1, trackFlags: 3, durationMovieTicks: duration, mediaTimescale: "1000", mediaDurationTicks: String(count * 40),
      edits: [{ segmentDurationMovieTicks: duration, mediaTimeTrackTicks: mediaTime, mediaRateFixed16_16: rate }] }] },
    physical: { streamIndex: 0, trackId: 1, sourceTimeBase: r(1, 1000), frames: Array.from({ length: count }, (_, index) => ({ rawDecodeOrdinal: index, ptsTicks: String(index * 40) })) },
  };
}

// Independent literals from each fixture's edit list (design §2 存储格式, §5 时间线).
const ISO_VIDEO_SPANS: Record<string, EditSpan[]> = {
  "cfr.mp4": [span(r(1, 4), r(19, 8), r(0))],
  "vfr.mp4": [span(r(3, 16), r(83, 16), r(0))],
  "audio-tail.mp4": [span(r(1, 4), r(19, 8), r(0))],
  "positive-start.mp4": [span(r(1, 4), r(19, 8), r(1, 4))],
  "single-tail-cut": [span(r(1, 4), r(5, 4), r(0))],
  "negative-preroll": [span(r(3, 4), r(7, 4), r(0))],
  "two-nonempty": [span(r(1, 4), r(3, 4), r(0)), span(r(5, 4), r(7, 4), r(1, 2))],
  "repeated-edit": [span(r(1, 4), r(3, 4), r(0)), span(r(1, 4), r(3, 4), r(1, 2))],
  "leading-empty": [span(r(1, 4), r(5, 4), r(1, 4))],
  "backward-jump": [span(r(5, 4), r(7, 4), r(0)), span(r(1, 4), r(3, 4), r(1, 2))],
  "mid-frame-start": [span(r(5, 16), r(21, 16), r(0))],
};
const ISO_AUDIO_SPANS: Record<string, EditSpan[]> = {
  "vfr.mp4": [span(r(8, 375), r(1883, 375), r(0))],
  "audio-tail.mp4": [span(r(8, 375), r(1508, 375), r(0))],
};
const ISO_SOURCE_RUNS: Record<string, SourceRun[]> = {
  "cfr.mp4": [{ start: 4096, count: 17, step: 2048 }],
  "two-nonempty": [{ start: 4096, count: 4, step: 2048 }, { start: 20480, count: 4, step: 2048 }],
  "repeated-edit": [{ start: 4096, count: 4, step: 2048 }, { start: 4096, count: 4, step: 2048 }],
  "backward-jump": [{ start: 20480, count: 4, step: 2048 }, { start: 4096, count: 4, step: 2048 }],
  "mid-frame-start": [{ start: 4096, count: 9, step: 2048 }],
};
const MATROSKA_SOURCE_RUNS: Record<string, SourceRun[]> = {
  K01: [{ start: 0, count: 3, step: 40 }],
  K02: [{ start: 0, count: 2, step: 40 }, { start: 140, count: 1, step: 0 }],
  K03: [{ start: 0, count: 2, step: 60 }],
  K04: [{ start: 30, count: 2, step: 40 }],
  K05: [{ start: 7, count: 2, step: 40 }],
  K08: [{ start: 40, count: 1, step: 0 }],
};
const STORED_KEYS = ["attempt", "audioEdits", "presentation", "producerVersion", "schemaVersion", "source", "sourceFingerprint", "videoEdits"];
const PRODUCER_ONLY = ["blockOrdinal", "elementOffset", "dataOffset", "dataBytes", "rawDecodeOrdinal", "mappedPts", "editOccurrence", "physical", "container", "strategy", "clusterTimestampTicks"];

/**
 * Check the invariants every produced pair satisfies.
 * @param output - The producer output.
 * @param expectedFrames - The presented frames the output must describe, as display intervals and source ticks.
 * @returns Nothing.
 */
function expectPair(output: { ledger: LedgerV2; table: VideoPresentationTable }, expectedFrames: readonly { displayStart: Rational; displayEnd: Rational; sourcePtsTicks: string }[]): void {
  const projected = projectPresentationTable(expectedFrames.map(({ displayStart, displayEnd }) => ({ displayStart, displayEnd })));
  expect(output.table).toEqual(projected);
  expect(presentationTableSchema.parse(output.table)).toEqual(projected);
  expect(output.ledger.presentation).toEqual(output.table);
  const ticks = expectedFrames.map((frame) => Number(frame.sourcePtsTicks));
  expect(expandSource(output.ledger.source.runs)).toEqual(ticks);
  expect(output.ledger.source.runs).toEqual(encodeSource(ticks));
  expect(Object.keys(output.ledger).sort()).toEqual(STORED_KEYS);
  const json = JSON.stringify(output.ledger);
  for (const key of PRODUCER_ONLY) expect(json).not.toContain(`"${key}"`);
  expect(ledgerSchema()(JSON.parse(json))).toEqual(output.ledger);
}

describe("A source ledger v2 and compact table from one pure producer call", () => {
  it.each(ORIGINAL_ISO_ASSEMBLY_FIXTURES.map((fixture) => fixture.id))("A01 ISO %s: compact table is the projection, source runs expand to every presented frame, video spans follow the edit list", (id) => {
    const fixture = ORIGINAL_ISO_ASSEMBLY_FIXTURES.find((entry) => entry.id === id)!;
    const audio = id in ISO_AUDIO_SPANS ? 2 : null;
    const output = assemble()(isoFixture(id, audio));
    expectPair(output, fixture.expected.frames);
    expect(output.ledger.source.timeBase).toEqual(fixture.physical.sourceTimeBase);
    const video = fixture.metadata.tracks.find((track) => track.trackId === fixture.physical.trackId)!;
    expect(output.ledger.videoEdits).toEqual(spansOf(video.edits!, fixture.metadata.movieTimescale, video.mediaTimescale));
    if (id in ISO_VIDEO_SPANS) expect(output.ledger.videoEdits).toEqual(ISO_VIDEO_SPANS[id]);
    expect(output.ledger.audioEdits).toEqual(ISO_AUDIO_SPANS[id] ?? null);
    if (id in ISO_SOURCE_RUNS) expect(output.ledger.source.runs).toEqual(ISO_SOURCE_RUNS[id]);
  });

  it("A02 stores exactly the consumer fields for cfr.mp4", () => {
    expect(assemble()(isoFixture("cfr.mp4")).ledger).toEqual({
      schemaVersion: 2, sourceFingerprint: IDENTITY.sourceFingerprint, producerVersion: 2, attempt: IDENTITY.attempt,
      presentation: { schemaVersion: 1, timescale: 8, runs: [{ start: 0, count: 17, step: 1, duration: 1 }] },
      source: { timeBase: r(1, 16384), runs: [{ start: 4096, count: 17, step: 2048 }] },
      videoEdits: [span(r(1, 4), r(19, 8), r(0))],
      audioEdits: null,
    });
  });

  it.each(MATROSKA_PRESENTATION_CASES.filter((entry) => entry.expected !== null).map((entry) => entry.id))("A03 Matroska %s: no edit lists, skipped and invisible frames absent, no block evidence stored", (id) => {
    const fixture = MATROSKA_PRESENTATION_CASES.find((entry) => entry.id === id)!;
    const output = assemble()(matroskaFixture(id));
    expectPair(output, fixture.expected!.frames);
    expect(output.ledger.source.runs).toEqual(MATROSKA_SOURCE_RUNS[id]);
    expect(output.ledger.source.timeBase).toEqual(fixture.physical.sourceTimeBase);
    expect(output.ledger.videoEdits).toBeNull();
    expect(output.ledger.audioEdits).toBeNull();
  });

  it("A04 unedited ISO stores no video edit list and keeps the declared last-sample duration", () => {
    const input: IsoInput = {
      ...structuredClone(IDENTITY), kind: "iso_bmff", audioTrackId: null,
      metadata: { movieTimescale: "1000", movieDurationTicks: "120", tracks: [{ trackId: 7, trackFlags: 3, durationMovieTicks: "120", mediaTimescale: "1000", mediaDurationTicks: "120", edits: null,
        sampleTiming: { decodeRuns: [{ sampleCount: 3, deltaTicks: "40" }], cttsVersion: null, compositionRuns: null, compositionShift: null } }] },
      physical: { streamIndex: 0, trackId: 7, sourceTimeBase: r(1, 1000), frames: ["0", "40", "80"].map((ptsTicks, rawDecodeOrdinal) => ({ rawDecodeOrdinal, ptsTicks })) },
    };
    const output = assemble()(input);
    expect(output.table).toEqual({ schemaVersion: 1, timescale: 25, runs: [{ start: 0, count: 3, step: 1, duration: 1 }] });
    expect(output.ledger.source).toEqual({ timeBase: r(1, 1000), runs: [{ start: 0, count: 3, step: 40 }] });
    expect(output.ledger.videoEdits).toBeNull();
    expect(output.ledger.audioEdits).toBeNull();
  });

  it("A05 rate 2 edit presents the source twice as fast", () => {
    const output = assemble()(rated("131072", "100", "0"));
    expect(output.table).toEqual({ schemaVersion: 1, timescale: 50, runs: [{ start: 0, count: 5, step: 1, duration: 1 }] });
    expect(output.ledger.source.runs).toEqual([{ start: 0, count: 5, step: 40 }]);
    expect(output.ledger.videoEdits).toEqual([span(r(0), r(1, 5), r(0), r(2))]);
  });

  it("A06 rate 1/2 edit presents the source at half speed and clips the last frame at the edit end", () => {
    const output = assemble()(rated("32768", "100", "0"));
    expect(output.table).toEqual({ schemaVersion: 1, timescale: 50, runs: [{ start: 0, count: 1, step: 4, duration: 4 }, { start: 4, count: 1, step: 1, duration: 1 }] });
    expect(output.ledger.source.runs).toEqual([{ start: 0, count: 2, step: 40 }]);
    expect(output.ledger.videoEdits).toEqual([span(r(0), r(1, 20), r(0), r(1, 2))]);
  });

  it("A07 rate 3/2 edit starting mid-frame keeps the partly cut first frame", () => {
    const output = assemble()(rated("98304", "100", "20"));
    expect(output.table).toEqual({ schemaVersion: 1, timescale: 150, runs: [{ start: 0, count: 1, step: 2, duration: 2 }, { start: 2, count: 3, step: 4, duration: 4 }, { start: 14, count: 1, step: 1, duration: 1 }] });
    expect(output.ledger.source.runs).toEqual([{ start: 0, count: 5, step: 40 }]);
    expect(output.ledger.videoEdits).toEqual([span(r(1, 50), r(17, 100), r(0), r(3, 2))]);
  });

  it.each(["0", "-65536", "-32768"])("A08 rejects video edit rate %s with unsupported_rate", (rate) => {
    const producer = assemble();
    expect(() => producer(rated(rate, "100", "0"))).toThrowError(expect.objectContaining({ code: "unsupported_rate" }));
  });

  it("A09 scaling the edit rate scales presentation time and keeps the presented source frames (property)", () => {
    const rates = [[1n, 1n], [1n, 2n], [3n, 2n], [2n, 1n], [3n, 1n], [1n, 4n], [5n, 4n], [7n, 8n], [5n, 2n]] as const;
    fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: 50 }), { minLength: 1, maxLength: 30 }), fc.nat(), fc.integer({ min: 1, max: 60 }), fc.constantFrom(...rates), (deltas, mediaPick, unit, [a, b]) => {
      const pts = deltas.reduce<number[]>((all, delta) => [...all, (all.at(-1) ?? 0) + delta], [0]);
      const mediaTime = pts[mediaPick % pts.length]!;
      const duration = BigInt(unit) * 8n;
      /**
       * A one-edit millisecond source at the given rate and segment duration.
       * @param rate - Fixed 16.16 rate.
       * @param segment - Segment duration in movie milliseconds.
       * @returns The input.
       */
      const source = (rate: bigint, segment: bigint): IsoInput => ({
        ...structuredClone(IDENTITY), kind: "iso_bmff", audioTrackId: null,
        metadata: { movieTimescale: "1000", movieDurationTicks: String(segment), tracks: [{ trackId: 1, trackFlags: 3, durationMovieTicks: String(segment), mediaTimescale: "1000", mediaDurationTicks: String(pts.at(-1)! + 50),
          edits: [{ segmentDurationMovieTicks: String(segment), mediaTimeTrackTicks: String(mediaTime), mediaRateFixed16_16: String(rate) }] }] },
        physical: { streamIndex: 0, trackId: 1, sourceTimeBase: r(1, 1000), frames: pts.map((tick, rawDecodeOrdinal) => ({ rawDecodeOrdinal, ptsTicks: String(tick) })) },
      });
      // Same source range [mediaTime, mediaTime + duration·a/b): rate a/b over `duration`, rate 1 over `duration·a/b`.
      const one = assemble()(source(65536n, duration * a / b));
      const scaled = assemble()(source(a * 65536n / b, duration));
      expect(scaled.ledger.source.runs).toEqual(one.ledger.source.runs);
      const oneFrames = expandTable(one.table);
      const scaledFrames = expandTable(scaled.table);
      expect(scaledFrames.length).toBe(oneFrames.length);
      const ts1 = BigInt(one.table.timescale);
      const tsr = BigInt(scaled.table.timescale);
      scaledFrames.forEach((frame, index) => {
        // time at rate a/b × a/b = time at rate 1, compared exactly.
        expect(BigInt(frame.start) * a * ts1).toBe(BigInt(oneFrames[index]!.start) * tsr * b);
        expect(BigInt(frame.end) * a * ts1).toBe(BigInt(oneFrames[index]!.end) * tsr * b);
      });
      expect(scaled.ledger.videoEdits).toEqual([{ ...one.ledger.videoEdits![0]!, rate: reduce(a, b) }]);
    }), { seed: 1306, numRuns: 120 });
  });

  it("A10 rate-one edit lists: the pair matches the existing explicit planner frame by frame (property)", () => {
    const edit = fc.record({ pick: fc.nat(), duration: fc.integer({ min: 1, max: 2000 }) });
    fc.assert(fc.property(fc.integer({ min: 0, max: 50 }), fc.array(fc.integer({ min: 1, max: 100 }), { maxLength: 40 }), fc.constantFrom("600", "1000"), fc.option(fc.integer({ min: 1, max: 500 }), { nil: null }), fc.array(edit, { minLength: 1, maxLength: 3 }),
      (first, deltas, movieTimescale, leadingEmpty, edits) => {
        const pts = deltas.reduce<number[]>((all, delta) => [...all, all.at(-1)! + delta], [first]);
        const list: IsoBmffEdit[] = [
          ...(leadingEmpty === null ? [] : [{ segmentDurationMovieTicks: String(leadingEmpty), mediaTimeTrackTicks: "-1", mediaRateFixed16_16: "65536" }]),
          ...edits.map((item) => ({ segmentDurationMovieTicks: String(item.duration), mediaTimeTrackTicks: String(pts[item.pick % pts.length]!), mediaRateFixed16_16: "65536" })),
        ];
        const metadata: IsoBmffMetadata = { movieTimescale, movieDurationTicks: "1", tracks: [{ trackId: 1, trackFlags: 3, durationMovieTicks: "1", mediaTimescale: "1000", mediaDurationTicks: String(pts.at(-1)! + 100), edits: list }] };
        const physical: PhysicalVideoProbe = { streamIndex: 0, trackId: 1, sourceTimeBase: r(1, 1000), frames: pts.map((tick, rawDecodeOrdinal) => ({ rawDecodeOrdinal, ptsTicks: String(tick) })) };
        const reference = assembleExplicitIsoVideoPresentation(structuredClone(metadata), structuredClone(physical), 1_000_000)!;
        const output = assemble()({ ...structuredClone(IDENTITY), kind: "iso_bmff", metadata, physical, audioTrackId: null });
        expectPair(output, reference.frames);
        expect(output.ledger.videoEdits).toEqual(spansOf(list, movieTimescale, "1000"));
      }), { seed: 1306, numRuns: 150 });
  });

  it("A11 audio track keeps its own edit list, independent of the video edits", () => {
    const input = isoFixture("cfr.mp4", 2);
    input.metadata.tracks.push({ trackId: 2, trackFlags: 3, durationMovieTicks: "1250", mediaTimescale: "48000", mediaDurationTicks: "96000", edits: [
      { segmentDurationMovieTicks: "250", mediaTimeTrackTicks: "-1", mediaRateFixed16_16: "65536" },
      { segmentDurationMovieTicks: "1000", mediaTimeTrackTicks: "1024", mediaRateFixed16_16: "65536" },
      { segmentDurationMovieTicks: "1000", mediaTimeTrackTicks: "1024", mediaRateFixed16_16: "131072" },
    ] });
    const output = assemble()(input);
    expect(output.ledger.audioEdits).toEqual([span(r(8, 375), r(383, 375), r(1, 4)), span(r(8, 375), r(758, 375), r(5, 4), r(2))]);
    expect(output.ledger.videoEdits).toEqual(ISO_VIDEO_SPANS["cfr.mp4"]);
  });

  it("A12 audio without an edit list, or no audio, stores null; an audio edit list of only empty edits stores []", () => {
    const unedited = isoFixture("cfr.mp4", 2);
    unedited.metadata.tracks.push({ trackId: 2, trackFlags: 3, durationMovieTicks: "1000", mediaTimescale: "48000", mediaDurationTicks: "48000", edits: null });
    expect(assemble()(unedited).ledger.audioEdits).toBeNull();
    expect(assemble()(isoFixture("cfr.mp4", null)).ledger.audioEdits).toBeNull();
    const silent = isoFixture("cfr.mp4", 2);
    silent.metadata.tracks.push({ trackId: 2, trackFlags: 3, durationMovieTicks: "1000", mediaTimescale: "48000", mediaDurationTicks: "48000", edits: [{ segmentDurationMovieTicks: "1000", mediaTimeTrackTicks: "-1", mediaRateFixed16_16: "65536" }] });
    expect(assemble()(silent).ledger.audioEdits).toEqual([]);
  });

  it("A13 rejects an audio rate of zero and an audio track that is not in the file", () => {
    const zero = isoFixture("cfr.mp4", 2);
    zero.metadata.tracks.push({ trackId: 2, trackFlags: 3, durationMovieTicks: "1000", mediaTimescale: "48000", mediaDurationTicks: "48000", edits: [{ segmentDurationMovieTicks: "1000", mediaTimeTrackTicks: "0", mediaRateFixed16_16: "0" }] });
    const producer = assemble();
    expect(() => producer(zero)).toThrowError(expect.objectContaining({ code: "unsupported_rate" }));
    expect(() => producer(isoFixture("cfr.mp4", 9))).toThrowError(Error);
  });

  it("A14 has no frame ceiling and stores a constant-rate source in constant size", { timeout: 60_000 }, () => {
    const count = 100_001;
    const output = assemble()(rated("65536", String(count * 40), "0", count));
    expect(output.table).toEqual({ schemaVersion: 1, timescale: 25, runs: [{ start: 0, count, step: 1, duration: 1 }] });
    expect(output.ledger.source.runs).toEqual([{ start: 0, count, step: 40 }]);
    expect(JSON.stringify(output.ledger).length).toBeLessThan(1024);
    expect(JSON.stringify(output.table).length).toBeLessThan(256);
  });

  it.each([
    ["only empty edits", [{ segmentDurationMovieTicks: "250", mediaTimeTrackTicks: "-1", mediaRateFixed16_16: "65536" }]],
    ["an empty edit list", []],
    ["only a zero-duration edit", [{ segmentDurationMovieTicks: "0", mediaTimeTrackTicks: "4096", mediaRateFixed16_16: "65536" }]],
  ] as const)("A15 fails with content code no_presented_frames for %s instead of storing an empty table", (_, edits) => {
    const input = isoFixture("cfr.mp4");
    input.metadata.tracks[0]!.edits = [...edits];
    const producer = assemble();
    expect(() => producer(input)).toThrowError(expect.objectContaining({ code: "no_presented_frames" }));
  });

  it("A16 is pure: frozen input unchanged, no clock read, identity passed through (property)", () => {
    const producer = assemble();
    const now = vi.spyOn(Date, "now");
    fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 40 }), fc.integer({ min: 1, max: 7_201_000 }), (jobId, deadlineAt) => {
      const input = isoFixture("mid-frame-start");
      input.attempt = { jobId, deadlineAt };
      const before = structuredClone(input);
      const output = producer(Object.freeze(input));
      expect(input).toEqual(before);
      expect(output.ledger.attempt).toEqual({ jobId, deadlineAt });
      expect(output.ledger.sourceFingerprint).toBe(IDENTITY.sourceFingerprint);
    }), { seed: 1306, numRuns: 32 });
    expect(now).not.toHaveBeenCalled();
  });

  // Design §2 覆盖范围: the display rule for these inputs is measured on real samples
  // (Chromium playback and ffmpeg) before it is specified; unclear rules go to the user.
  it.todo("A17 Matroska last displayed frame without a declared duration (K06, MediaRecorder WebM): rule pending §2 real-sample measurement");
  it.todo("A17 unedited MP4 with a cslg box: display window rule pending §2 real-sample measurement");
});
