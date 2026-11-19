// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { inspectMatroskaFile, inspectMatroskaMetadata, type MatroskaByteSource, type MatroskaTrackMetadata } from "@ingest/container/matroska-metadata.js";
import { block, byteSource, cluster, document, element, info, trackEntry, uint, uniqueOffset, vint, type MetadataReadRequest } from "@ingest/container/__tests__/matroska-metadata-fixtures.js";

const LIMITS = { metadataBytes: 16384, elementCount: 256, maxBlocks: 32 };
const TRACK: MatroskaTrackMetadata = { trackNumber: "3", trackUid: "4", trackType: "1", codecId: "V_VP9", enabled: true, defaultDurationNs: null, trackTimestampScale: { numerator: "1", denominator: "1" }, codecDelayNs: "0" };

/** Assemble the ordinary one-track metadata, without any presentation calculation.
 * @throws {RangeError} When fixture integers cannot be encoded.
 */
function ordinary(blocks: Buffer[] = [block(0)], extra: Buffer[] = [], headerInfo = info()): Buffer {
  return document([headerInfo, element("1654ae6b", trackEntry(3n, 4n, extra)), cluster(0n, blocks)]);
}

// Source facts: K01-K08 from the independent source-ledger oracle. The reader
// expectations deliberately do not contain its presentation or track-linkage outputs.
const ORDINARY_CASES = [
  { id: "K01", uid: 9007199254740993n, duration: 40000000n, delay: 0n, durationHint: true, blocks: [block(0), block(40), block(80)], expected: [["0", null, false], ["40", null, false], ["80", null, false]] },
  { id: "K02", uid: 4n, duration: null, delay: 0n, durationHint: false, blocks: [block(0), block(40), block(140, { group: true, duration: 60n })], expected: [["0", null, false], ["40", null, false], ["140", "60", false]] },
  { id: "K03", uid: 4n, duration: null, delay: 0n, durationHint: false, blocks: [block(0, { group: true, duration: 20n }), block(60, { group: true, duration: 20n })], expected: [["0", "20", false], ["60", "20", false]] },
  { id: "K04", uid: 4n, duration: 40000000n, delay: 0n, durationHint: false, blocks: [block(-10), block(30), block(70)], expected: [["-10", null, false], ["30", null, false], ["70", null, false]] },
  { id: "K05", uid: 4n, duration: 40000000n, delay: 7000000n, durationHint: false, blocks: [block(14), block(54)], expected: [["14", null, false], ["54", null, false]] },
  { id: "K06", uid: 4n, duration: null, delay: 0n, durationHint: true, blocks: [block(0), block(40)], expected: [["0", null, false], ["40", null, false]] },
  { id: "K08", uid: 4n, duration: 40000000n, delay: 0n, durationHint: false, blocks: [block(0, { flags: 8 }), block(40)], expected: [["0", null, true], ["40", null, false]] },
];

describe("bounded Matroska source metadata, without decoding or a presentation policy", () => {
  it.each(ORDINARY_CASES)("preserves the original $id metadata without filtering physical blocks", async (sample) => {
    const bytes = document([
      info([element("2ad7b1", uint(1000000n)), ...(sample.durationHint ? [element("4489", Buffer.from("40af400000000000", "hex"))] : [])]),
      element("1654ae6b", trackEntry(3n, sample.uid, [element("56aa", uint(sample.delay)), ...(sample.duration === null ? [] : [element("23e383", uint(sample.duration))])])),
      cluster(0n, sample.blocks),
    ]);
    const result = await inspectMatroskaMetadata(byteSource(bytes), LIMITS);
    expect(result.timestampScaleNs).toBe("1000000");
    expect(result.tracks).toEqual([{ ...TRACK, trackUid: sample.uid.toString(), defaultDurationNs: sample.duration === null ? null : sample.duration.toString(), codecDelayNs: sample.delay.toString() }]);
    expect(result.blocks.map((entry) => [entry.relativeTimestampTicks, entry.blockDurationTicks, entry.invisible])).toEqual(sample.expected);
    expect(result.blocks.map((entry) => [entry.blockOrdinal, entry.trackNumber, entry.clusterTimestampTicks, entry.lacing, entry.frameCount, entry.discardPaddingNs, entry.dataBytes])).toEqual(sample.expected.map((_, index) => [index, "3", "0", "none", 1, null, "3"]));
  });

  it("K07 retains every actual track identity rather than binding an ISO or physical stream index", async () => {
    const bytes = document([info(), element("1654ae6b", Buffer.concat([trackEntry(2n, 8n, [], 2n, "A_OPUS"), trackEntry(3n, 9007199254740993n)])), cluster(0n, [block(0, { track: 2n }), block(40)])]);
    const result = await inspectMatroskaMetadata(byteSource(bytes), LIMITS);
    expect(result.tracks).toEqual([{ ...TRACK, trackNumber: "2", trackUid: "8", trackType: "2", codecId: "A_OPUS" }, { ...TRACK, trackUid: "9007199254740993" }]);
    expect(result.blocks.map((entry) => [entry.blockOrdinal, entry.trackNumber, entry.relativeTimestampTicks])).toEqual([[0, "2", "0"], [1, "3", "40"]]);
  });

  it("uses the normative absent defaults while leaving DefaultDuration absent", async () => {
    const result = await inspectMatroskaMetadata(byteSource(ordinary([block(0)], [], info([]))), LIMITS);
    expect(result.timestampScaleNs).toBe("1000000");
    expect(result.tracks).toEqual([TRACK]);
  });

  it("reads Empty Elements as declared defaults and distinguishes zero padding from absence", async () => {
    const empty = Buffer.alloc(0);
    const group = element("a0", Buffer.concat([element("a1", Buffer.from("8300000011", "hex")), element("75a2", empty)]));
    const bytes = document([info([element("2ad7b1", empty)]), element("1654ae6b", trackEntry(3n, 4n, [element("b9", empty), element("23314f", empty), element("56aa", empty)])), cluster(0n, [group])], false, 3);
    const result = await inspectMatroskaMetadata(byteSource(bytes), LIMITS);
    expect(result.timestampScaleNs).toBe("1000000"); expect(result.tracks).toEqual([TRACK]);
    expect(result.blocks.map((entry) => entry.discardPaddingNs)).toEqual(["0"]);
  });

  it("retains explicit disabled tracks, uint64 identity and nanosecond facts without rounding", async () => {
    const bytes = document([info([element("2ad7b1", uint(18446744073709551615n))]), element("1654ae6b", trackEntry(3n, 18446744073709551615n, [element("b9", uint(0n, 1)), element("23e383", uint(9007199254740993n)), element("56aa", uint(9007199254740995n))])), cluster(9007199254740997n, [block(-32768), block(32767)])]);
    const result = await inspectMatroskaMetadata(byteSource(bytes), LIMITS);
    expect(result.timestampScaleNs).toBe("18446744073709551615");
    expect(result.tracks).toEqual([{ ...TRACK, trackUid: "18446744073709551615", enabled: false, defaultDurationNs: "9007199254740993", codecDelayNs: "9007199254740995" }]);
    expect(result.blocks.map((entry) => [entry.clusterTimestampTicks, entry.relativeTimestampTicks])).toEqual([["9007199254740997", "-32768"], ["9007199254740997", "32767"]]);
  });

  it.each([
    ["3dcccccd", "13421773", "134217728"],
    ["3fb999999999999a", "3602879701896397", "36028797018963968"],
    ["3fc00000", "3", "2"],
  ])("keeps exact IEEE track-scale rational from %s", async (hex, numerator, denominator) => {
    const bytes = document([info(), element("1654ae6b", trackEntry(3n, 4n, [element("23314f", Buffer.from(hex, "hex"))])), cluster(0n, [block(0)])], false, 3);
    expect((await inspectMatroskaMetadata(byteSource(bytes), LIMITS)).tracks).toEqual([{ ...TRACK, trackTimestampScale: { numerator, denominator } }]);
  });

  it("keeps large track-number VINTs separate from the exact TrackUID", async () => {
    const bytes = document([info(), element("1654ae6b", trackEntry(9007199254740993n, 16078647074689634010n)), cluster(0n, [block(5, { track: 9007199254740993n })])]);
    const result = await inspectMatroskaMetadata(byteSource(bytes), LIMITS);
    expect(result.tracks).toEqual([{ ...TRACK, trackNumber: "9007199254740993", trackUid: "16078647074689634010" }]);
    expect(result.blocks.map((entry) => [entry.trackNumber, entry.relativeTimestampTicks])).toEqual([["9007199254740993", "5"]]);
  });

  it.each([8500000n, -8500000n, -9223372036854775808n, 9223372036854775807n])("keeps signed DiscardPadding %s without editing duration", async (padding) => {
    const result = await inspectMatroskaMetadata(byteSource(ordinary([block(14, { group: true, duration: 9007199254740993n, padding })])), LIMITS);
    expect(result.blocks.map((entry) => [entry.kind, entry.relativeTimestampTicks, entry.blockDurationTicks, entry.discardPaddingNs])).toEqual([["group", "14", "9007199254740993", padding.toString()]]);
  });

  it("points a grouped block at the Block ID, after skipping unrelated codec additions", async () => {
    const encodedBlock = element("a1", Buffer.from("83002800112233", "hex"));
    const group = element("a0", Buffer.concat([element("a4", Buffer.from("a3ff1f43b675", "hex")), encodedBlock, element("9b", uint(60n))]));
    const bytes = ordinary([group]); const offset = uniqueOffset(bytes, encodedBlock);
    const result = await inspectMatroskaMetadata(byteSource(bytes), LIMITS);
    expect(result.blocks).toEqual([{ blockOrdinal: 0, kind: "group", elementOffset: String(offset), dataOffset: String(offset + 6), dataBytes: "3", trackNumber: "3", clusterTimestampTicks: "0", relativeTimestampTicks: "40", invisible: false, lacing: "none", frameCount: 1, blockDurationTicks: "60", discardPaddingNs: null }]);
  });

  it.each([
    { name: "none", flags: 0, lace: [], frames: 1, elementHeader: 2, header: 4, payload: 9 },
    { name: "xiph", flags: 2, lace: [2, 2, 3], frames: 3, elementHeader: 2, header: 7, payload: 9 },
    { name: "fixed", flags: 4, lace: [2], frames: 3, elementHeader: 2, header: 5, payload: 9 },
    { name: "ebml", flags: 6, lace: [2, 0x82, 0xc0], frames: 3, elementHeader: 2, header: 7, payload: 9 },
    { name: "ebml", flags: 6, lace: [3, 0x85, 0xbc, 0xc1], frames: 4, elementHeader: 2, header: 8, payload: 12 },
    { name: "xiph", flags: 2, lace: [1, 255, 0], frames: 2, elementHeader: 3, header: 7, payload: 256 },
  ])("locates complete $name lace header with $frames frames, without reading codec payload", async (sample) => {
    const encoded = block(9, { flags: sample.flags, lace: sample.lace, payload: Buffer.alloc(sample.payload, 0x5a) });
    const bytes = ordinary([encoded]); const elementOffset = uniqueOffset(bytes, encoded);
    const payloadOffset = elementOffset + sample.elementHeader + sample.header; const reads: MetadataReadRequest[] = [];
    const result = await inspectMatroskaMetadata(byteSource(bytes, reads), LIMITS);
    expect(result.blocks).toEqual([{ blockOrdinal: 0, kind: "simple", elementOffset: String(elementOffset), dataOffset: String(payloadOffset), dataBytes: String(sample.payload), trackNumber: "3", clusterTimestampTicks: "0", relativeTimestampTicks: "9", invisible: false, lacing: sample.name, frameCount: sample.frames, blockDurationTicks: null, discardPaddingNs: null }]);
    expect(reads.every((read) => read.offset + BigInt(read.length) <= BigInt(payloadOffset) || read.offset >= BigInt(payloadOffset + sample.payload))).toBe(true);
  });

  it("finishes consecutive unknown-size clusters at real level-one boundaries and EOF", async () => {
    const bytes = document([info(), element("1654ae6b", trackEntry()), cluster(0n, [block(-10)], true), element("1c53bb6b", Buffer.alloc(0)), cluster(500n, [block(30)], true)], true);
    const result = await inspectMatroskaMetadata(byteSource(bytes), LIMITS);
    expect(result.tracks).toEqual([TRACK]);
    expect(result.blocks.map((entry) => [entry.blockOrdinal, entry.clusterTimestampTicks, entry.relativeTimestampTicks])).toEqual([[0, "0", "-10"], [1, "500", "30"]]);
  });

  it("does not swallow late Info and Tracks as unknown-size Cluster children", async () => {
    const bytes = document([cluster(0n, [block(0)], true), info([element("2ad7b1", uint(2000000n))]), element("1654ae6b", trackEntry()), cluster(40n, [block(1)], true)], true);
    const result = await inspectMatroskaMetadata(byteSource(bytes), LIMITS);
    expect(result.timestampScaleNs).toBe("2000000"); expect(result.tracks).toEqual([TRACK]);
    expect(result.blocks.map((entry) => [entry.clusterTimestampTicks, entry.relativeTimestampTicks])).toEqual([["0", "0"], ["40", "1"]]);
  });

  it("does not return a complete prefix when the next cluster crosses actual EOF", async () => {
    const bytes = document([info(), element("1654ae6b", trackEntry()), cluster(0n, [block(0)], true), Buffer.from("1f43b6758a00", "hex")], true);
    await expect(inspectMatroskaMetadata(byteSource(bytes), LIMITS)).rejects.toMatchObject({ code: "invalid_element" });
  });

  it("skips known-size unknown elements and codec-private bytes without interpreting embedded IDs", async () => {
    const opaque = Buffer.from("1f43b675ff1549a966ff1654ae6bffa3ff", "hex");
    const bytes = document([info(), element("4abc", opaque), element("1654ae6b", trackEntry(3n, 4n, [element("63a2", opaque)])), cluster(0n, [block(0, { payload: opaque })])]);
    const reads: MetadataReadRequest[] = [];
    expect((await inspectMatroskaMetadata(byteSource(bytes, reads), LIMITS)).blocks.map((entry) => [entry.trackNumber, entry.dataBytes])).toEqual([["3", "17"]]);
    const starts = [uniqueOffset(bytes, element("4abc", opaque)) + 3, uniqueOffset(bytes, element("63a2", opaque)) + 3, uniqueOffset(bytes, block(0, { payload: opaque })) + 6];
    expect(reads.every((read) => starts.every((start) => read.offset + BigInt(read.length) <= BigInt(start) || read.offset >= BigInt(start + opaque.length)))).toBe(true);
  });

  it("skips an exact size-VINT payload beyond 2^53 without allocating or rounding it", async () => {
    const prefix = document([], true); const voidSize = 9007199254741011n;
    const voidHeader = Buffer.concat([Buffer.from("ec", "hex"), vint(voidSize, 8)]);
    const lead = Buffer.concat([prefix, voidHeader]); const tail = Buffer.concat([info(), element("1654ae6b", trackEntry()), cluster(0n, [block(0)])]);
    const tailOffset = BigInt(lead.length) + voidSize; const reads: MetadataReadRequest[] = [];
    const source: MatroskaByteSource = { size: tailOffset + BigInt(tail.length), read: async (offset, length) => {
      reads.push({ offset, length });
      if (offset < BigInt(lead.length)) return lead.subarray(Number(offset), Number(offset) + length);
      if (offset >= tailOffset) return tail.subarray(Number(offset - tailOffset), Number(offset - tailOffset) + length);
      throw new Error("Reader entered a skipped payload");
    } };
    const result = await inspectMatroskaMetadata(source, LIMITS);
    expect(result.tracks).toEqual([TRACK]);
    expect(result.blocks.map((entry) => entry.elementOffset)).toEqual([(tailOffset + BigInt(uniqueOffset(tail, block(0)))).toString()]);
    expect(reads.some((read) => read.offset === tailOffset)).toBe(true);
  });

  it("reads the same immutable bytes through the real file adapter", async () => {
    const directory = await mkdtemp(join(tmpdir(), "matroska-metadata-red-"));
    try {
      const file = join(directory, "input.webm"); await writeFile(file, ordinary());
      const result = await inspectMatroskaFile(file, LIMITS);
      expect(result.tracks).toEqual([TRACK]);
      expect(result.blocks.map((entry) => [entry.blockOrdinal, entry.trackNumber, entry.relativeTimestampTicks, entry.dataBytes])).toEqual([[0, "3", "0", "3"]]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("validates every mandatory budget before any source read", async () => {
    const reads: MetadataReadRequest[] = [];
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      for (const key of ["metadataBytes", "elementCount", "maxBlocks"] as const) await expect(inspectMatroskaMetadata(byteSource(ordinary(), reads), { ...LIMITS, [key]: value })).rejects.toMatchObject({ code: "invalid_limits" });
    }
    expect(reads).toEqual([]);
  });

  it("enforces cumulative metadata-byte budget before asking for excess bytes", async () => {
    const reads: MetadataReadRequest[] = [];
    await expect(inspectMatroskaMetadata(byteSource(ordinary(), reads), { ...LIMITS, metadataBytes: 8 })).rejects.toMatchObject({ code: "resource_limit" });
    expect(reads.reduce((sum, read) => sum + read.length, 0)).toBeLessThanOrEqual(8);
  });

  it("counts elements cumulatively across masters, not just the selected metadata", async () => {
    await expect(inspectMatroskaMetadata(byteSource(ordinary()), { ...LIMITS, elementCount: 1 })).rejects.toMatchObject({ code: "resource_limit" });
  });

  it("counts every track's blocks across cluster boundaries", async () => {
    const bytes = document([info(), element("1654ae6b", Buffer.concat([trackEntry(), trackEntry(2n, 8n, [], 2n, "A_OPUS")])), cluster(0n, [block(0)]), cluster(40n, [block(0, { track: 2n })])]);
    await expect(inspectMatroskaMetadata(byteSource(bytes), { ...LIMITS, maxBlocks: 1 })).rejects.toMatchObject({ code: "resource_limit" });
  });

  it("retains an IO failure cause instead of calling a partial ledger complete", async () => {
    const cause = new Error("Original object read failed");
    await expect(inspectMatroskaMetadata({ size: 500n, read: async () => { throw cause; } }, LIMITS)).rejects.toMatchObject({ code: "read_failed", cause });
  });

  it("rejects actual short reads without padding metadata", async () => {
    await expect(inspectMatroskaMetadata({ size: 500n, read: async () => new Uint8Array(0) }, LIMITS)).rejects.toMatchObject({ code: "truncated_read" });
  });

  it("rejects a negative declared source size before any IO", async () => {
    const reads: MetadataReadRequest[] = [];
    await expect(inspectMatroskaMetadata({ size: -1n, read: async (offset, length) => { reads.push({ offset, length }); return new Uint8Array(0); } }, LIMITS)).rejects.toMatchObject({ code: "invalid_element" });
    expect(reads).toEqual([]);
  });

  it.each([
    { name: "zero VINT marker", bytes: Buffer.from("00", "hex") },
    { name: "incomplete ID", bytes: Buffer.from("1a45", "hex") },
    { name: "element beyond source", bytes: Buffer.from("1a45dfa34080", "hex") },
    { name: "child beyond parent", bytes: document([info(), element("1654ae6b", Buffer.from("ae8ad781", "hex"))]) },
    { name: "short block timestamp", bytes: ordinary([element("a3", Buffer.from("8300", "hex"))]) },
    { name: "zero block track marker", bytes: ordinary([element("a3", Buffer.from("0000000011", "hex"))]) },
    { name: "oversized unsigned integer", bytes: ordinary([], [element("56aa", Buffer.alloc(9))]) },
    { name: "invalid float width", bytes: ordinary([], [element("23314f", Buffer.from("3f80", "hex"))]) },
    { name: "unterminated Xiph size", bytes: ordinary([element("a3", Buffer.from("8300000201ff", "hex"))]) },
    { name: "Xiph size past payload", bytes: ordinary([block(0, { flags: 2, lace: [1, 10], payload: Buffer.alloc(3) })]) },
    { name: "fixed lace indivisible payload", bytes: ordinary([block(0, { flags: 4, lace: [2], payload: Buffer.alloc(8) })]) },
    { name: "negative EBML lace size", bytes: ordinary([block(0, { flags: 6, lace: [2, 0x81, 0x80], payload: Buffer.alloc(4) })]) },
    { name: "EBML size past payload", bytes: ordinary([block(0, { flags: 6, lace: [1, 0x89], payload: Buffer.alloc(4) })]) },
  ])("rejects invalid binary $name", async ({ bytes }) => {
    await expect(inspectMatroskaMetadata(byteSource(bytes), LIMITS)).rejects.toMatchObject({ code: "invalid_element" });
  });

  it.each([
    document([info([element("2ad7b1", uint(1n)), element("2ad7b1", uint(2n))]), element("1654ae6b", trackEntry()), cluster(0n, [block(0)])]),
    ordinary([], [element("d7", uint(4n))]),
    document([info(), element("1654ae6b", trackEntry()), element("1f43b675", Buffer.concat([element("e7", uint(0n)), element("e7", uint(1n)), block(0)]))]),
    ordinary([element("a0", Buffer.concat([element("a1", Buffer.from("8300000011", "hex")), element("a1", Buffer.from("8300280022", "hex"))]))]),
  ])("rejects duplicate singleton facts instead of selecting a later value", async (bytes) => {
    await expect(inspectMatroskaMetadata(byteSource(bytes), LIMITS)).rejects.toMatchObject({ code: "duplicate_metadata" });
  });

  it.each([
    document([element("1654ae6b", trackEntry()), cluster(0n, [block(0)])]),
    document([info(), cluster(0n, [block(0)])]),
    document([info(), element("1654ae6b", element("ae", Buffer.concat([element("d7", uint(3n)), element("83", uint(1n)), element("86", Buffer.from("V_VP9"))]))), cluster(0n, [block(0)])]),
    document([info(), element("1654ae6b", trackEntry()), element("1f43b675", block(0))]),
  ])("rejects missing required metadata rather than inventing identity or cluster time", async (bytes) => {
    await expect(inspectMatroskaMetadata(byteSource(bytes), LIMITS)).rejects.toMatchObject({ code: "missing_metadata" });
  });

  it.each([
    document([info(), element("1654ae6b", trackEntry()), element("4abc", Buffer.alloc(0), true)], true),
    document([info(), element("1654ae6b", trackEntry()), element("1f43b675", Buffer.concat([element("e7", uint(0n)), element("4abc", Buffer.alloc(0), true)]), true)], true),
    document([info(), element("1654ae6b", trackEntry()), element("a3", Buffer.from("8300000011", "hex"), true)], true),
  ])("rejects unknown-size elements without a permitted known hierarchy", async (bytes) => {
    await expect(inspectMatroskaMetadata(byteSource(bytes), LIMITS)).rejects.toMatchObject({ code: "unsupported_structure" });
  });

  it("keeps random uint64 UIDs and signed relative timestamps exact while respecting source bounds", async () => {
    await fc.assert(fc.asyncProperty(fc.bigInt({ min: 1n, max: 18446744073709551615n }), fc.integer({ min: -32768, max: 32767 }), async (uid, relative) => {
      const bytes = document([info(), element("1654ae6b", trackEntry(3n, uid)), cluster(32768n, [block(relative)])]); const reads: MetadataReadRequest[] = [];
      const result = await inspectMatroskaMetadata(byteSource(bytes, reads), LIMITS);
      expect(result.tracks).toEqual([{ ...TRACK, trackUid: uid.toString() }]);
      expect(result.blocks.map((entry) => [entry.clusterTimestampTicks, entry.relativeTimestampTicks])).toEqual([["32768", String(relative)]]);
      expect(reads.every((read) => read.offset >= 0n && read.offset + BigInt(read.length) <= BigInt(bytes.length))).toBe(true);
      expect(reads.reduce((sum, read) => sum + read.length, 0)).toBeLessThanOrEqual(LIMITS.metadataBytes);
    }), { seed: 1306, numRuns: 64 });
  });
});
