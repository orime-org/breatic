// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assembleVideoSourceLedger, type VideoSourceLedgerAssemblyInput } from "@ingest/container/assemble-video-source-ledger.js";
import * as explicitOwner from "@ingest/container/explicit-iso-video-presentation.js";
import * as uneditedOwner from "@ingest/container/unedited-iso-video-presentation.js";
import * as matroskaOwner from "@ingest/container/matroska-video-presentation.js";
import { inspectIsoBmffMetadata } from "@ingest/container/iso-bmff-metadata.js";
import type { OwnedVideoPresentation, VideoSourceLedgerCompanion } from "@shared/upload/video-source-ledger-types.js";
import { videoSourceLedgerCompanionSchema } from "@shared/upload/video-source-ledger.js";
import { ORIGINAL_ISO_ASSEMBLY_FIXTURES } from "./helpers/source-ledger-assembly-fixtures.js";
import { MATROSKA_PRESENTATION_CASES } from "./helpers/matroska-presentation-fixtures.js";
import { SAMPLE_METADATA_LIMITS, sampleByteSource, sampleMovie, sampleTrack, sampleStts, sampleCtts } from "./helpers/iso-sample-timing-fixtures.js";

type IsoInput = Extract<VideoSourceLedgerAssemblyInput, { kind: "iso_bmff" }>;
type MatroskaInput = Extract<VideoSourceLedgerAssemblyInput, { kind: "matroska" }>;
const IDENTITY = { sourceFingerprint: "a".repeat(64), attempt: { jobId: "original-accepted-attempt", deadlineAt: 1 }, limits: { maxPhysicalFrames: 100, maxOccurrences: 100 } };
const CFR = { edits: [], frames: [
  { presentationOrdinal: 0, editOccurrence: 0, rawDecodeOrdinal: 0, sourcePtsTicks: "0", mappedPts: { numerator: "0", denominator: "1" }, displayStart: { numerator: "0", denominator: "1" }, displayEnd: { numerator: "1", denominator: "25" } },
  { presentationOrdinal: 1, editOccurrence: 0, rawDecodeOrdinal: 1, sourcePtsTicks: "40", mappedPts: { numerator: "1", denominator: "25" }, displayStart: { numerator: "1", denominator: "25" }, displayEnd: { numerator: "2", denominator: "25" } },
  { presentationOrdinal: 2, editOccurrence: 0, rawDecodeOrdinal: 2, sourcePtsTicks: "80", mappedPts: { numerator: "2", denominator: "25" }, displayStart: { numerator: "2", denominator: "25" }, displayEnd: { numerator: "3", denominator: "25" } },
] };

afterEach(() => vi.restoreAllMocks());

/** Construct original source facts with no IO or runtime clock observation.
 * @throws {never} Never.
 */
function original(id = "cfr.mp4"): IsoInput {
  const fixture = ORIGINAL_ISO_ASSEMBLY_FIXTURES.find((entry) => entry.id === id)!;
  return { ...structuredClone(IDENTITY), sourceFingerprint: fixture.sourceFingerprint, kind: "iso_bmff", metadata: structuredClone(fixture.metadata), physical: structuredClone(fixture.physical) };
}

/** Read the same real binary sample-table fixtures already used by the independent N tests.
 * @throws {Error} When the bounded in-memory metadata reader rejects a fixture.
 */
async function ordinary(id = "N01"): Promise<IsoInput> {
  const deltas = id === "N02" ? ["40", "100", "60"] : ["40", "40", "40"];
  const boxes = [sampleStts(deltas.map((deltaTicks) => ({ sampleCount: 1, deltaTicks }))), ...(id === "N03" ? [sampleCtts(1, ["0", "40", "-40"].map((offsetTicks) => ({ sampleCount: 1, offsetTicks })))] : [])];
  const metadata = await inspectIsoBmffMetadata(sampleByteSource(sampleMovie([
    sampleTrack({ trackId: 11, mediaTimescale: 48000, mediaDuration: 192000, trackDuration: 4000, sampleBoxes: [sampleStts([{ sampleCount: 4, deltaTicks: "48000" }])] }),
    sampleTrack({ trackId: 7, mediaTimescale: 1000, mediaDuration: id === "N02" ? 200 : 120, sampleBoxes: boxes }),
  ])), SAMPLE_METADATA_LIMITS);
  const pts = id === "N02" ? ["0", "40", "140"] : id === "N04" ? ["0", "20", "40"] : ["0", "40", "80"];
  return { ...structuredClone(IDENTITY), kind: "iso_bmff", metadata, physical: { streamIndex: 3, trackId: 7, sourceTimeBase: { numerator: id === "N04" ? "2" : "1", denominator: "1000" }, frames: pts.map((ptsTicks, rawDecodeOrdinal) => ({ rawDecodeOrdinal, ptsTicks })) } };
}

/** Clone the independently specified original Matroska track/block facts.
 * @throws {never} Never.
 */
function matroska(id = "K01"): MatroskaInput {
  const fixture = MATROSKA_PRESENTATION_CASES.find((entry) => entry.id === id)!;
  return { ...structuredClone(IDENTITY), kind: "matroska", metadata: structuredClone(fixture.metadata), physical: structuredClone(fixture.physical) };
}

/** Require the owned companion shape while keeping mathematical expectations independent.
 * @throws {Error} When assembly, exact equality or the already-validated shared shape fails.
 */
function expectOutput(input: VideoSourceLedgerAssemblyInput, presentation: OwnedVideoPresentation, strategy: VideoSourceLedgerCompanion["strategy"], container: VideoSourceLedgerCompanion["container"]): VideoSourceLedgerCompanion {
  const before = structuredClone(input);
  const originalContainer = structuredClone(container);
  const expected = { schemaVersion: 1, producerVersion: 1, sourceFingerprint: before.sourceFingerprint, attempt: before.attempt, strategy, physical: before.physical, container: originalContainer, presentation };
  const actual = assembleVideoSourceLedger(input);
  expect(actual).toEqual(expected);
  expect(input).toEqual(before);
  expect(videoSourceLedgerCompanionSchema.parse(actual)).toEqual(expected);
  return actual;
}

/** Reject invalid complete facts without counting the RED sentinel as a working guard.
 * @throws {Error} When the input is accepted or the implementation remains a throw-stub.
 */
function expectRejected(input: VideoSourceLedgerAssemblyInput): void {
  let error: unknown;
  try { assembleVideoSourceLedger(input); } catch (cause) { error = cause; }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error & { code?: string }).code).not.toBe("not_implemented");
}

describe("pure complete source-ledger assembly through the original format owners", () => {
  it.each(ORIGINAL_ISO_ASSEMBLY_FIXTURES)("preserves original $id complete metadata, physical facts and independent exact window", (fixture) => {
    const input = original(fixture.id);
    expectOutput(input, fixture.expected, "iso_explicit_rate_one", { kind: "iso_bmff", movieTimescale: fixture.metadata.movieTimescale, movieDurationTicks: fixture.metadata.movieDurationTicks, track: fixture.metadata.tracks[0]! });
  });

  it("calls the real explicit owner and does not enter the unedited fallback for repeated edits", () => {
    const input = original("repeated-edit"); const explicit = vi.spyOn(explicitOwner, "assembleExplicitIsoVideoPresentation"); const fallback = vi.spyOn(uneditedOwner, "assembleUneditedIsoVideoPresentation");
    const expected = ORIGINAL_ISO_ASSEMBLY_FIXTURES.find((entry) => entry.id === "repeated-edit")!.expected;
    const output = assembleVideoSourceLedger(input);
    expect(output.presentation).toEqual(expected); expect(explicit).toHaveBeenCalledExactlyOnceWith(input.metadata, input.physical, 100); expect(fallback).not.toHaveBeenCalled();
    expect(output.presentation.frames.map((frame) => frame.rawDecodeOrdinal)).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
  });

  it.each(["all-empty", "empty-edit-list"])("keeps J12/J13 %s as explicit instead of treating empty output as absent edits", (kind) => {
    const input = original(); const track = input.metadata.tracks[0]!;
    track.edits = kind === "all-empty" ? [{ segmentDurationMovieTicks: "250", mediaTimeTrackTicks: "-1", mediaRateFixed16_16: "65536" }] : [];
    const expected = { edits: kind === "all-empty" ? [{ editOccurrence: 0, empty: true, start: { numerator: "0", denominator: "1" }, end: { numerator: "1", denominator: "4" } }] : [], frames: [] };
    input.limits = { maxPhysicalFrames: 17, maxOccurrences: 1 }; const fallback = vi.spyOn(uneditedOwner, "assembleUneditedIsoVideoPresentation");
    expectOutput(input, expected, "iso_explicit_rate_one", { kind: "iso_bmff", movieTimescale: input.metadata.movieTimescale, movieDurationTicks: input.metadata.movieDurationTicks, track });
    expect(fallback).not.toHaveBeenCalled();
  });

  it.each(["N01", "N02", "N03", "N04"])("uses only the actual null explicit sentinel for %s and keeps declared sample support", async (id) => {
    const input = await ordinary(id); const explicit = vi.spyOn(explicitOwner, "assembleExplicitIsoVideoPresentation"); const fallback = vi.spyOn(uneditedOwner, "assembleUneditedIsoVideoPresentation");
    const expected = structuredClone(CFR);
    if (id === "N02") {
      expected.frames[1]!.displayEnd = { numerator: "7", denominator: "50" }; expected.frames[2] = { ...expected.frames[2]!, sourcePtsTicks: "140", mappedPts: { numerator: "7", denominator: "50" }, displayStart: { numerator: "7", denominator: "50" }, displayEnd: { numerator: "1", denominator: "5" } };
    }
    if (id === "N04") { expected.frames[1]!.sourcePtsTicks = "20"; expected.frames[2]!.sourcePtsTicks = "40"; }
    expectOutput(input, expected, "iso_unedited_rate_one", { kind: "iso_bmff", movieTimescale: input.metadata.movieTimescale, movieDurationTicks: input.metadata.movieDurationTicks, track: input.metadata.tracks[1]! });
    expect(explicit).toHaveBeenCalledExactlyOnceWith(input.metadata, input.physical, 100); expect(fallback).toHaveBeenCalledExactlyOnceWith(input.metadata, input.physical, 100);
    expect(input.metadata.tracks[1]!.edits).toBeNull();
  });

  it.each(MATROSKA_PRESENTATION_CASES.filter((entry) => entry.expected !== null))("delegates complete $id physical-only and displayed identities to the real Matroska owner", (fixture) => {
    const input = matroska(fixture.id); const owner = vi.spyOn(matroskaOwner, "assembleMatroskaVideoPresentation");
    expectOutput(input, fixture.expected!, "matroska_rate_one", { kind: "matroska", timestampScaleNs: fixture.metadata.timestampScaleNs, track: fixture.metadata.tracks[0]!, blocks: fixture.metadata.blocks });
    expect(owner).toHaveBeenCalledExactlyOnceWith(input.metadata, input.physical, 100);
  });

  it("selects complete Matroska blocks by actual track while retaining their original global ordinals", () => {
    const input = matroska(); const expectedBlocks = input.metadata.blocks.map((block, index) => ({ ...block, blockOrdinal: [1, 3, 6][index]! }));
    input.physical.frames.forEach((frame, index) => { frame.blockOrdinal = [1, 3, 6][index]!; });
    const selectedTrack = input.metadata.tracks[0]!; input.metadata.tracks.unshift({ ...selectedTrack, trackNumber: "2", trackUid: "8", trackType: "2", codecId: "A_OPUS" });
    input.metadata.blocks = [{ ...expectedBlocks[0]!, blockOrdinal: 0, trackNumber: "2", elementOffset: "100", dataOffset: "110" }, ...expectedBlocks, { ...expectedBlocks[2]!, blockOrdinal: 7, trackNumber: "2", elementOffset: "700", dataOffset: "710" }];
    const expected = MATROSKA_PRESENTATION_CASES.find((entry) => entry.id === "K01")!.expected!;
    expectOutput(input, expected, "matroska_rate_one", { kind: "matroska", timestampScaleNs: input.metadata.timestampScaleNs, track: selectedTrack, blocks: expectedBlocks });
  });

  it("passes through the original accepted job and expired deadline without observing the runtime clock", () => {
    const input = original(); const now = vi.spyOn(Date, "now");
    const output = assembleVideoSourceLedger(input); expect(output.attempt).toEqual({ jobId: "original-accepted-attempt", deadlineAt: 1 }); expect(output.sourceFingerprint).toBe(input.sourceFingerprint); expect(now).not.toHaveBeenCalled();
  });

  it.each(["K04", "K08"])("keeps %s raw physical-only frames while applying only the legal occurrence ceiling", (id) => {
    const input = matroska(id); const fixture = MATROSKA_PRESENTATION_CASES.find((entry) => entry.id === id)!;
    input.limits = { maxPhysicalFrames: input.physical.frames.length, maxOccurrences: fixture.expected!.frames.length };
    const output = assembleVideoSourceLedger(input); expect(output.physical).toEqual(input.physical); expect(output.presentation).toEqual(fixture.expected);
  });

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("rejects invalid mandatory ceiling %s before invoking any format owner", (value) => {
    const explicit = vi.spyOn(explicitOwner, "assembleExplicitIsoVideoPresentation"); const fallback = vi.spyOn(uneditedOwner, "assembleUneditedIsoVideoPresentation"); const native = vi.spyOn(matroskaOwner, "assembleMatroskaVideoPresentation");
    const input = original(); input.limits.maxPhysicalFrames = value; expectRejected(input);
    input.limits = { maxPhysicalFrames: 100, maxOccurrences: value }; expectRejected(input);
    expect(explicit).not.toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled(); expect(native).not.toHaveBeenCalled();
  });

  it("rejects the physical count before invoking a planner even when the legal schedule would be empty", () => {
    const input = original(); input.metadata.tracks[0]!.edits = []; input.limits.maxPhysicalFrames = 16;
    const explicit = vi.spyOn(explicitOwner, "assembleExplicitIsoVideoPresentation"); expectRejected(input); expect(explicit).not.toHaveBeenCalled();
  });

  it("rejects an empty physical source instead of manufacturing a completed empty ledger", () => {
    const input = original(); input.metadata.tracks[0]!.edits = []; input.physical.frames = []; expectRejected(input);
  });

  it("rejects occurrence overflow without returning a truncated companion", () => {
    const input = original("repeated-edit"); input.limits.maxOccurrences = 7; expectRejected(input);
  });

  it.each(["missing-track", "ambiguous-track", "non-positive-rate"])("keeps original explicit rejection for %s rather than starting an unedited fallback", (kind) => {
    const input = original();
    if (kind === "missing-track") input.physical.trackId = 99;
    if (kind === "ambiguous-track") input.metadata.tracks.push({ ...input.metadata.tracks[0]! });
    if (kind === "non-positive-rate") input.metadata.tracks[0]!.edits![0]!.mediaRateFixed16_16 = "0";
    const fallback = vi.spyOn(uneditedOwner, "assembleUneditedIsoVideoPresentation"); expectRejected(input); expect(fallback).not.toHaveBeenCalled();
  });

  it("does not replace an existing format owner's actual thrown object", () => {
    const input = original(); const expected = new Error("Existing format owner failure");
    vi.spyOn(explicitOwner, "assembleExplicitIsoVideoPresentation").mockImplementationOnce(() => { throw expected; });
    let actual: unknown; try { assembleVideoSourceLedger(input); } catch (error) { actual = error; }
    expect(actual).toBe(expected);
  });

  it.each(["missing-timing", "composition-shift"])("preserves the original unedited unsupported %s boundary", async (kind) => {
    const input = await ordinary(); const selected = input.metadata.tracks[1]!;
    if (kind === "missing-timing") delete selected.sampleTiming;
    else selected.sampleTiming!.compositionShift = { version: 0, compositionToDtsShift: "0", leastDecodeToDisplayDelta: "0", greatestDecodeToDisplayDelta: "0", compositionStartTime: "0", compositionEndTime: "120" };
    expectRejected(input);
  });

  it.each(["K06", "wrong-track", "lacing", "non-rate-one"])("keeps the original Matroska unsupported %s boundary", (kind) => {
    const input = matroska(kind === "K06" ? "K06" : "K01");
    if (kind === "wrong-track") input.physical.trackUid = "999";
    if (kind === "lacing") { input.metadata.blocks[0]!.lacing = "ebml"; input.metadata.blocks[0]!.frameCount = 2; }
    if (kind === "non-rate-one") input.metadata.tracks[0]!.trackTimestampScale = { numerator: "3", denominator: "2" };
    expectRejected(input);
  });

  it("does not mutate frozen input facts or require destructive clock normalization", () => {
    const input = original("mid-frame-start"); const before = structuredClone(input);
    Object.freeze(input.attempt); Object.freeze(input.limits); Object.freeze(input.physical.sourceTimeBase);
    for (const frame of input.physical.frames) Object.freeze(frame); Object.freeze(input.physical.frames); Object.freeze(input.physical);
    for (const track of input.metadata.tracks) { if (track.edits) { for (const edit of track.edits) Object.freeze(edit); Object.freeze(track.edits); } Object.freeze(track); }
    Object.freeze(input.metadata.tracks); Object.freeze(input.metadata); Object.freeze(input);
    expect(assembleVideoSourceLedger(input).presentation).toEqual(ORIGINAL_ISO_ASSEMBLY_FIXTURES.find((entry) => entry.id === "mid-frame-start")!.expected);
    expect(input).toEqual(before);
  });

  it("preserves admitted identity and deadline across independent pure calls", () => {
    fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 40 }), fc.integer({ min: 1, max: 7201000 }), (jobId, deadlineAt) => {
      const input = original(); input.attempt = { jobId, deadlineAt };
      const output = assembleVideoSourceLedger(input); expect(output.attempt).toEqual(input.attempt); expect(output.sourceFingerprint).toBe(input.sourceFingerprint);
      expect(output.presentation).toEqual(ORIGINAL_ISO_ASSEMBLY_FIXTURES[0]!.expected);
    }), { seed: 1306, numRuns: 64 });
  });
});
