// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { IsoBmffEdit, IsoBmffMetadata, IsoBmffTrackMetadata } from "@ingest/container/iso-bmff-metadata.js";
import { planEditListPresentation, type ExactPresentationTime, type OwnedVideoPresentation } from "@ingest/container/iso-bmff-presentation.js";
import type { PhysicalVideoProbe } from "@shared/upload/video-source-ledger-types.js";

// The edit-list planner (planEditListPresentation) on a selected track's metadata and frames, as the plan probe reads them.

/**
 * Plan the selected physical track's explicit edit list.
 * @param iso - Container metadata.
 * @param physical - The selected video track's clock and frames.
 * @param maxOccurrences - The expansion ceiling.
 * @returns The schedule, or null when the track has no edit list.
 * @throws {Error} When track association, exact planning or the ceiling fails.
 */
function assembleExplicitIsoVideoPresentation(iso: IsoBmffMetadata, physical: PhysicalVideoProbe, maxOccurrences: number): OwnedVideoPresentation | null {
  const matches = iso.tracks.filter((track) => track.trackId === physical.trackId);
  if (matches.length !== 1) throw new Error("Expected one ISO track matching the original physical video track");
  const track = matches[0]!;
  if (track.edits === null) return null;
  return planEditListPresentation({ movieTimescale: iso.movieTimescale, mediaTimescale: track.mediaTimescale, sourceTimeBase: physical.sourceTimeBase,
    edits: track.edits, frames: physical.frames }, maxOccurrences);
}

/** Encode an independently specified reduced fraction without floating-point conversion.
 * @throws {never} Never.
 */
function time(numerator: string, denominator: string = "1"): ExactPresentationTime { return { numerator, denominator }; }

/** Construct one complete edit fact from the finite fixture.
 * @throws {never} Never.
 */
function edit(duration: string = "500", mediaTime: string = "4096", rate: string = "65536"): IsoBmffEdit {
  return { segmentDurationMovieTicks: duration, mediaTimeTrackTicks: mediaTime, mediaRateFixed16_16: rate };
}

/** Return independent track facts with video track 42 deliberately last.
 * @throws {never} Never.
 */
function metadata(): IsoBmffMetadata {
  return {
    movieTimescale: "1000", movieDurationTicks: "9000",
    tracks: [
      { trackId: 5, trackFlags: 1, durationMovieTicks: "9000", mediaTimescale: "48000", mediaDurationTicks: "432000", edits: [edit("9000", "0")] },
      { trackId: 99, trackFlags: 1, durationMovieTicks: "1000", mediaTimescale: "90000", mediaDurationTicks: "90000", edits: [edit("1000", "0")] },
      { trackId: 42, trackFlags: 1, durationMovieTicks: "1000", mediaTimescale: "16384", mediaDurationTicks: "50000", edits: [edit(), edit()] },
    ],
  };
}

/** Return the complete physical ledger in its original non-unit-numerator source clock.
 * @throws {never} Never.
 */
function physical(): PhysicalVideoProbe {
  return { streamIndex: 1, trackId: 42, sourceTimeBase: time("2", "16384"), frames: Array.from({ length: 17 }, (_, rawDecodeOrdinal) => ({ rawDecodeOrdinal, ptsTicks: String(2048 + rawDecodeOrdinal * 1024) })) };
}

/** Identify the fixture track without using its array position as a media identity.
 * @throws {never} Never; the fixture always supplies exactly one track 42.
 */
function selected(iso: IsoBmffMetadata): IsoBmffTrackMetadata { return iso.tracks.find((track) => track.trackId === 42)!; }

const EIGHT = [time("0"), time("1", "8"), time("1", "4"), time("3", "8"), time("1", "2"), time("5", "8"), time("3", "4"), time("7", "8"), time("1")];
const SOURCE_ROWS = [[0, "2048"], [1, "3072"], [2, "4096"], [3, "5120"], [0, "2048"], [1, "3072"], [2, "4096"], [3, "5120"]] as const;

/** Materialize the eight complete independently specified occurrence rows, not planner output.
 * @throws {never} Never.
 */
function golden(): OwnedVideoPresentation {
  return {
    edits: [{ editOccurrence: 0, empty: false, start: time("0"), end: time("1", "2") }, { editOccurrence: 1, empty: false, start: time("1", "2"), end: time("1") }],
    frames: SOURCE_ROWS.map(([rawDecodeOrdinal, sourcePtsTicks], presentationOrdinal) => ({ presentationOrdinal, editOccurrence: presentationOrdinal < 4 ? 0 : 1, rawDecodeOrdinal, sourcePtsTicks, mappedPts: EIGHT[presentationOrdinal]!, displayStart: EIGHT[presentationOrdinal]!, displayEnd: EIGHT[presentationOrdinal + 1]! })),
  };
}

/** Freeze every mutable input container to expose writes while retaining the existing typed boundary.
 * @throws {never} Never.
 */
function freezeFacts(iso: IsoBmffMetadata, probe: PhysicalVideoProbe): void {
  for (const track of iso.tracks) {
    if (track.edits !== null) { for (const entry of track.edits) Object.freeze(entry); Object.freeze(track.edits); }
    Object.freeze(track);
  }
  Object.freeze(iso.tracks); Object.freeze(iso);
  for (const frame of probe.frames) Object.freeze(frame);
  Object.freeze(probe.frames); Object.freeze(probe.sourceTimeBase); Object.freeze(probe);
}

describe("explicit ISO video track association and exact assembly", () => {
  it("J1 returns every exact fraction and repeated raw identity from the complete golden without changing inputs", () => {
    const iso = metadata(); const probe = physical(); const before = structuredClone({ iso, probe });
    expect(assembleExplicitIsoVideoPresentation(iso, probe, 32)).toEqual(golden());
    expect({ iso, probe }).toEqual(before);
  });
  it("J2 joins track identity under arbitrary complete track permutations", () => {
    fc.assert(fc.property(fc.shuffledSubarray([0, 1, 2], { minLength: 3, maxLength: 3 }), (order) => {
      const iso = metadata(); const tracks = iso.tracks; iso.tracks = order.map((index) => tracks[index]!);
      const probe = physical(); const before = structuredClone({ iso, probe });
      expect(assembleExplicitIsoVideoPresentation(iso, probe, 32)).toEqual(golden());
      expect({ iso, probe }).toEqual(before);
    }));
  });
  it("J3 keeps ffprobe streamIndex separate from ISO track IDs and edit occurrences", () => {
    expect(assembleExplicitIsoVideoPresentation(metadata(), { ...physical(), streamIndex: 7 }, 32)).toEqual(golden());
  });
  it("J4 ignores unrelated clocks, flags and unsupported rates instead of selecting another track", () => {
    const iso = metadata();
    iso.tracks.unshift({ trackId: 1, trackFlags: 1, durationMovieTicks: "9000", mediaTimescale: "100", mediaDurationTicks: "900", edits: [edit("9000", "0", "32768")] });
    iso.tracks[1]!.edits = [edit("9000", "0", "0")];
    selected(iso).trackFlags = 0;
    expect(assembleExplicitIsoVideoPresentation(iso, physical(), 32)).toEqual(golden());
  });
  it("J5 rejects an absent matching track without falling back to tracks[streamIndex]", () => {
    const iso = metadata(); selected(iso).trackId = 1;
    expect(() => assembleExplicitIsoVideoPresentation(iso, physical(), 32)).toThrowError(Error);
  });
  it("J6 rejects duplicate matching track identities rather than silently taking the first", () => {
    const iso = metadata(); iso.tracks.push(structuredClone(selected(iso)));
    expect(() => assembleExplicitIsoVideoPresentation(iso, physical(), 32)).toThrowError(Error);
  });
  it("J7 keeps an equivalent physical rational clock without rewriting source ticks", () => {
    expect(assembleExplicitIsoVideoPresentation(metadata(), { ...physical(), sourceTimeBase: time("1", "8192") }, 32)).toEqual(golden());
  });
  it("J8 reads edit ticks in their independent track media timescale", () => {
    const iso = metadata(); selected(iso).mediaTimescale = "8192"; selected(iso).edits = [edit("500", "2048"), edit("500", "2048")];
    expect(assembleExplicitIsoVideoPresentation(iso, physical(), 32)).toEqual(golden());
  });
});

describe("complete explicit edit schedules without implicit policy", () => {
  it("J9 preserves an initial empty interval and shifts both repeated occurrences exactly", () => {
    const iso = metadata(); selected(iso).edits = [edit("250", "-1"), edit(), edit()];
    const starts = [time("1", "4"), time("3", "8"), time("1", "2"), time("5", "8"), time("3", "4"), time("7", "8"), time("1"), time("9", "8"), time("5", "4")];
    expect(assembleExplicitIsoVideoPresentation(iso, physical(), 32)).toEqual({
      edits: [{ editOccurrence: 0, empty: true, start: time("0"), end: time("1", "4") }, { editOccurrence: 1, empty: false, start: time("1", "4"), end: time("3", "4") }, { editOccurrence: 2, empty: false, start: time("3", "4"), end: time("5", "4") }],
      frames: SOURCE_ROWS.map(([rawDecodeOrdinal, sourcePtsTicks], presentationOrdinal) => ({ presentationOrdinal, editOccurrence: presentationOrdinal < 4 ? 1 : 2, rawDecodeOrdinal, sourcePtsTicks, mappedPts: starts[presentationOrdinal], displayStart: starts[presentationOrdinal], displayEnd: starts[presentationOrdinal + 1] })),
    });
  });
  it("J10 retains the overlapping first picture's negative mapped PTS and all nine exact occurrences", () => {
    const iso = metadata(); selected(iso).edits = [edit("1000", "5120")];
    const mapped = [time("-1", "16"), time("1", "16"), time("3", "16"), time("5", "16"), time("7", "16"), time("9", "16"), time("11", "16"), time("13", "16"), time("15", "16")];
    const starts = [time("0"), ...mapped.slice(1)]; const ends = [...mapped.slice(1), time("1")];
    expect(assembleExplicitIsoVideoPresentation(iso, physical(), 32)).toEqual({
      edits: [{ editOccurrence: 0, empty: false, start: time("0"), end: time("1") }],
      frames: ["2048", "3072", "4096", "5120", "6144", "7168", "8192", "9216", "10240"].map((sourcePtsTicks, rawDecodeOrdinal) => ({ presentationOrdinal: rawDecodeOrdinal, editOccurrence: 0, rawDecodeOrdinal, sourcePtsTicks, mappedPts: mapped[rawDecodeOrdinal], displayStart: starts[rawDecodeOrdinal], displayEnd: ends[rawDecodeOrdinal] })),
    });
  });
  it("J11 clips the final partial picture at the explicit edit end without expanding to a nominal frame interval", () => {
    const iso = metadata(); iso.movieTimescale = "16000"; selected(iso).edits = [edit("1000", "4096")];
    const probe = physical(); const before = structuredClone(probe);
    expect(assembleExplicitIsoVideoPresentation(iso, probe, 32)).toEqual({ edits: [{ editOccurrence: 0, empty: false, start: time("0"), end: time("1", "16") }], frames: [{ presentationOrdinal: 0, editOccurrence: 0, rawDecodeOrdinal: 0, sourcePtsTicks: "2048", mappedPts: time("0"), displayStart: time("0"), displayEnd: time("1", "16") }] });
    expect(probe).toEqual(before);
  });
  it("J12 retains the all-empty schedule without fabricating a physical picture", () => {
    const iso = metadata(); selected(iso).edits = [edit("250", "-1")];
    expect(assembleExplicitIsoVideoPresentation(iso, physical(), 32)).toEqual({ edits: [{ editOccurrence: 0, empty: true, start: time("0"), end: time("1", "4") }], frames: [] });
  });
  it("J13 distinguishes an explicit empty edit list from the absence of an edit list", () => {
    const iso = metadata(); selected(iso).edits = [];
    expect(assembleExplicitIsoVideoPresentation(iso, physical(), 32)).toEqual({ edits: [], frames: [] });
  });
  it("J14 returns an internal no-explicit-edits sentinel without declaring media unsupported", () => {
    const iso = metadata(); selected(iso).edits = null;
    expect(assembleExplicitIsoVideoPresentation(iso, physical(), 32)).toBeNull();
  });
  it("J15 leaves declared edit extents independent of other container duration facts", () => {
    const iso = metadata(); iso.movieDurationTicks = "9007199254740993"; selected(iso).durationMovieTicks = "123"; selected(iso).mediaDurationTicks = "987654321";
    expect(assembleExplicitIsoVideoPresentation(iso, physical(), 32)).toEqual(golden());
  });
  it("J16 retains a zero-width entry's edit identity without creating a frame", () => {
    const iso = metadata(); selected(iso).edits = [edit("0"), edit(), edit()];
    const expected = golden(); expected.edits = [{ editOccurrence: 0, empty: false, start: time("0"), end: time("0") }, { editOccurrence: 1, empty: false, start: time("0"), end: time("1", "2") }, { editOccurrence: 2, empty: false, start: time("1", "2"), end: time("1") }];
    expected.frames = expected.frames.map((frame) => ({ ...frame, editOccurrence: frame.editOccurrence + 1 }));
    expect(assembleExplicitIsoVideoPresentation(iso, physical(), 32)).toEqual(expected);
  });
});

describe("original rate-one planner error boundaries", () => {
  it("J17 rejects an occurrence ceiling of seven without truncating the eight repeated occurrences", () => {
    expect(() => assembleExplicitIsoVideoPresentation(metadata(), physical(), 7)).toThrowError(expect.objectContaining({ code: "resource_limit" }));
  });
  it("J17 allows exactly eight occurrences even though the physical input contains seventeen frames", () => {
    expect(assembleExplicitIsoVideoPresentation(metadata(), physical(), 8)).toEqual(golden());
  });
  it.each(["0", "-65536"])("J18 preserves unsupported_rate for selected non-positive rate %s", (rate) => {
    const iso = metadata(); selected(iso).edits = [edit("500", "4096", rate)];
    expect(() => assembleExplicitIsoVideoPresentation(iso, physical(), 32)).toThrowError(expect.objectContaining({ code: "unsupported_rate" }));
  });
  it.each([
    { label: "duplicate PTS", frames: [{ rawDecodeOrdinal: 0, ptsTicks: "2048" }, { rawDecodeOrdinal: 1, ptsTicks: "2048" }] },
    { label: "descending PTS", frames: [{ rawDecodeOrdinal: 0, ptsTicks: "3072" }, { rawDecodeOrdinal: 1, ptsTicks: "2048" }] },
    { label: "non-dense ordinal", frames: [{ rawDecodeOrdinal: 1, ptsTicks: "2048" }, { rawDecodeOrdinal: 2, ptsTicks: "3072" }] },
  ])("J19 preserves invalid_ledger without sorting or deduplicating $label", ({ frames }) => {
    const iso = metadata(); const probe = { ...physical(), frames }; const before = structuredClone({ iso, probe });
    expect(() => assembleExplicitIsoVideoPresentation(iso, probe, 32)).toThrowError(expect.objectContaining({ code: "invalid_ledger" }));
    expect({ iso, probe }).toEqual(before);
  });
  it.each(["movie", "media", "numerator", "denominator"].flatMap((field) => ["0", "N/A"].map((value) => ({ field, value }))))("J20 preserves invalid_clock for $field=$value", ({ field, value }) => {
    const iso = metadata(); const probe = physical();
    if (field === "movie") iso.movieTimescale = value;
    else if (field === "media") selected(iso).mediaTimescale = value;
    else probe.sourceTimeBase[field === "numerator" ? "numerator" : "denominator"] = value;
    expect(() => assembleExplicitIsoVideoPresentation(iso, probe, 32)).toThrowError(expect.objectContaining({ code: "invalid_clock" }));
  });
  it.each([
    { label: "media time below empty sentinel", entry: edit("500", "-2") },
    { label: "negative duration", entry: edit("-1", "4096") },
  ])("J20 preserves invalid_edit for $label", ({ entry }) => {
    const iso = metadata(); selected(iso).edits = [entry];
    expect(() => assembleExplicitIsoVideoPresentation(iso, physical(), 32)).toThrowError(expect.objectContaining({ code: "invalid_edit" }));
  });
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("J20 preserves invalid_limits for caller ceiling %s", (limit) => {
    expect(() => assembleExplicitIsoVideoPresentation(metadata(), physical(), limit)).toThrowError(expect.objectContaining({ code: "invalid_limits" }));
  });
  it("J21 replays identical complete schedules on shared frozen input without allocating new source identities", () => {
    const iso = metadata(); const probe = physical(); const before = structuredClone({ iso, probe }); freezeFacts(iso, probe);
    expect(assembleExplicitIsoVideoPresentation(iso, probe, 32)).toEqual(golden());
    expect(assembleExplicitIsoVideoPresentation(iso, probe, 32)).toEqual(golden());
    expect({ iso, probe }).toEqual(before);
  });
});
