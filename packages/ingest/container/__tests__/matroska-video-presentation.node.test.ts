// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assembleMatroskaVideoPresentation } from "@ingest/container/matroska-video-presentation.js";
import type { MatroskaMetadata } from "@ingest/container/matroska-metadata.js";
import type { MatroskaPhysicalVideoProbe } from "@ingest/container/physical-video-probe.js";
import { MATROSKA_PRESENTATION_CASES, type MatroskaPresentationCase } from "./helpers/matroska-presentation-fixtures.js";

/** Retrieve a fresh literal independent case, not an output of production arithmetic.
 * @throws {Error} When the finite fixture ID is absent.
 */
function sample(id = "K01"): MatroskaPresentationCase {
  const value = MATROSKA_PRESENTATION_CASES.find((entry) => entry.id === id);
  if (!value) throw new Error("Missing independent Matroska fixture");
  return structuredClone(value);
}

/** Require an actual owned rejection, never the unimplemented RED sentinel.
 * @throws {Error} When the assembler accepts invalid facts or remains a throw-stub.
 */
function expectRejected(metadata: MatroskaMetadata, physical: MatroskaPhysicalVideoProbe, limit = 32): void {
  let failure: unknown;
  try { assembleMatroskaVideoPresentation(metadata, physical, limit); }
  catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error & { code?: string }).code).not.toBe("not_implemented");
}

describe("common rate-one Matroska assembly from independent source-ledger goldens", () => {
  it.each(MATROSKA_PRESENTATION_CASES.filter((entry) => entry.expected !== null))("$id matches the complete literal occurrences and original raw identities", (entry) => {
    expect(assembleMatroskaVideoPresentation(entry.metadata, entry.physical, 32)).toEqual(entry.expected);
  });

  it("K06 rejects the missing terminal duration without a whole-segment or audio endpoint guess", () => {
    const entry = sample("K06");
    expect(entry.metadata.tracks[0]!.defaultDurationNs).toBeNull();
    expect(entry.metadata.blocks.at(-1)!.blockDurationTicks).toBeNull();
    expectRejected(entry.metadata, entry.physical);
  });

  it("K07 rejects an actual physical trackNumber/UID binding to an audio track", () => {
    const entry = sample();
    entry.metadata.tracks.unshift({ ...entry.metadata.tracks[0]!, trackNumber: "2", trackUid: "8", trackType: "2", codecId: "A_OPUS", defaultDurationNs: "20000000" });
    entry.physical.trackNumber = "2"; entry.physical.trackUid = "8";
    expectRejected(entry.metadata, entry.physical);
  });

  it("does not replace selected video durations with the audio sibling's longer timing", () => {
    const entry = sample();
    entry.metadata.tracks.unshift({ ...entry.metadata.tracks[0]!, trackNumber: "2", trackUid: "8", trackType: "2", codecId: "A_OPUS", defaultDurationNs: "4000000000", codecDelayNs: "6500000" });
    entry.metadata.blocks.push({ ...entry.metadata.blocks[0]!, blockOrdinal: 3, elementOffset: "600", dataOffset: "610", trackNumber: "2", blockDurationTicks: "4000", discardPaddingNs: "8500000" });
    expect(assembleMatroskaVideoPresentation(entry.metadata, entry.physical, 3)).toEqual(entry.expected);
  });

  it("associates a non-unit source numerator by exact cross-products without rebasing", () => {
    const entry = sample(); entry.physical.sourceTimeBase = { numerator: "2", denominator: "1000" };
    entry.physical.frames[1]!.ptsTicks = "20"; entry.physical.frames[2]!.ptsTicks = "40";
    const expected = structuredClone(entry.expected!); expected.frames[1]!.sourcePtsTicks = "20"; expected.frames[2]!.sourcePtsTicks = "40";
    expect(assembleMatroskaVideoPresentation(entry.metadata, entry.physical, 3)).toEqual(expected);
  });

  it.each(["K04", "K08"])("%s budgets legal occurrences while retaining the complete physical-only frames", (id) => {
    const entry = sample(id);
    expect(assembleMatroskaVideoPresentation(entry.metadata, entry.physical, entry.expected!.frames.length)).toEqual(entry.expected);
  });

  it("preserves the same timestamp when its cluster and relative components use different origins", () => {
    const entry = sample(); entry.metadata.blocks[1]!.clusterTimestampTicks = "35"; entry.metadata.blocks[1]!.relativeTimestampTicks = "5";
    expect(assembleMatroskaVideoPresentation(entry.metadata, entry.physical, 3)).toEqual(entry.expected);
  });

  it.each(["trackNumber", "trackUid"] as const)("rejects a mismatched selected %s", (field) => {
    const entry = sample(); entry.physical[field] = "999";
    expectRejected(entry.metadata, entry.physical);
  });

  it("rejects duplicate metadata track identities rather than selecting the first", () => {
    const entry = sample(); entry.metadata.tracks.push({ ...entry.metadata.tracks[0]! });
    expectRejected(entry.metadata, entry.physical);
  });

  it.each(["missing-frame", "repeated-block", "wrong-block", "sparse-raw", "extra-frame"])("rejects incomplete or ambiguous complete association: %s", (mutation) => {
    const entry = sample();
    if (mutation === "missing-frame") entry.physical.frames.pop();
    if (mutation === "repeated-block") entry.physical.frames[1]!.blockOrdinal = 0;
    if (mutation === "wrong-block") entry.physical.frames[1]!.blockOrdinal = 99;
    if (mutation === "sparse-raw") entry.physical.frames[1]!.rawDecodeOrdinal = 9;
    if (mutation === "extra-frame") entry.physical.frames.push({ rawDecodeOrdinal: 3, ptsTicks: "120", blockOrdinal: 3 });
    expectRejected(entry.metadata, entry.physical);
  });

  it("rejects a physical PTS that differs from its exact block/scale/delay time", () => {
    const entry = sample(); entry.physical.frames[1]!.ptsTicks = "41";
    expectRejected(entry.metadata, entry.physical);
  });

  it.each(["K04", "K08"])("validates %s physical-only frame association before excluding it from occurrences", (id) => {
    const entry = sample(id); entry.physical.frames[0]!.ptsTicks = "-999";
    expectRejected(entry.metadata, entry.physical);
  });

  it("rejects a stale selected block identity even if a different track has the same PTS", () => {
    const entry = sample(); entry.metadata.tracks.push({ ...entry.metadata.tracks[0]!, trackNumber: "4", trackUid: "44" }); entry.metadata.blocks[1]!.trackNumber = "4";
    expectRejected(entry.metadata, entry.physical);
  });

  it.each(["xiph", "fixed", "ebml"] as const)("does not invent timing for the unsupported %s lace", (lacing) => {
    const entry = sample(); entry.metadata.blocks[0]!.lacing = lacing; entry.metadata.blocks[0]!.frameCount = 2;
    expectRejected(entry.metadata, entry.physical);
  });

  it("rejects a non-rate-one track scale instead of silently changing the source clock", () => {
    const entry = sample(); entry.metadata.tracks[0]!.trackTimestampScale = { numerator: "3", denominator: "2" };
    expectRejected(entry.metadata, entry.physical);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 2])("rejects invalid or insufficient maxOccurrences %s without returning a prefix", (limit) => {
    const entry = sample(); expectRejected(entry.metadata, entry.physical, limit);
  });

  it("does not mutate frozen source metadata, physical identities or their source rational", () => {
    const entry = sample("K05"); const before = structuredClone(entry);
    for (const track of entry.metadata.tracks) { Object.freeze(track.trackTimestampScale); Object.freeze(track); }
    for (const block of entry.metadata.blocks) Object.freeze(block);
    for (const frame of entry.physical.frames) Object.freeze(frame);
    Object.freeze(entry.metadata.tracks); Object.freeze(entry.metadata.blocks); Object.freeze(entry.metadata); Object.freeze(entry.physical.sourceTimeBase); Object.freeze(entry.physical.frames); Object.freeze(entry.physical);
    expect(assembleMatroskaVideoPresentation(entry.metadata, entry.physical, 2)).toEqual(entry.expected);
    expect(entry).toEqual(before);
  });

  it("keeps the same literal schedule under exact original source-tick subdivisions", () => {
    fc.assert(fc.property(fc.bigInt({ min: 1n, max: 9007199254740993n }), (subdivision) => {
      const entry = sample(); entry.physical.sourceTimeBase = { numerator: "1", denominator: (1000n * subdivision).toString() };
      entry.physical.frames[1]!.ptsTicks = (40n * subdivision).toString(); entry.physical.frames[2]!.ptsTicks = (80n * subdivision).toString();
      const expected = structuredClone(entry.expected!); expected.frames[1]!.sourcePtsTicks = (40n * subdivision).toString(); expected.frames[2]!.sourcePtsTicks = (80n * subdivision).toString();
      expect(assembleMatroskaVideoPresentation(entry.metadata, entry.physical, 3)).toEqual(expected);
    }), { seed: 1306, numRuns: 64 });
  });
});
