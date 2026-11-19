// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { inspectIsoBmffFile, inspectIsoBmffMetadata, type IsoBmffCompositionShift } from "@ingest/container/iso-bmff-metadata.js";
import {
  SAMPLE_METADATA_LIMITS, sampleAtom, sampleByteSource, sampleCslg, sampleCtts, sampleMovie, sampleStts, sampleTrack,
  type SampleRead,
} from "./helpers/iso-sample-timing-fixtures.js";

const DECODE = [{ sampleCount: 2, deltaTicks: "40" }, { sampleCount: 1, deltaTicks: "60" }];
const SHIFT: IsoBmffCompositionShift = {
  version: 0, compositionToDtsShift: "40", leastDecodeToDisplayDelta: "-40",
  greatestDecodeToDisplayDelta: "40", compositionStartTime: "-40", compositionEndTime: "120",
};

describe("bounded ISO sample timing from actual binary tables", () => {
  it("keeps the existing no-stts track object exactly unchanged", async () => {
    const parsed = await inspectIsoBmffMetadata(sampleByteSource(sampleMovie([sampleTrack()])), SAMPLE_METADATA_LIMITS);
    expect(parsed).toEqual({ movieTimescale: "1000", movieDurationTicks: "4000", tracks: [{ trackId: 7, trackFlags: 3, durationMovieTicks: "120", mediaTimescale: "1000", mediaDurationTicks: "120", edits: null }] });
    expect(Object.hasOwn(parsed.tracks[0]!, "sampleTiming")).toBe(false);
  });

  it("retains stts compressed counts and exact unsigned decode deltas", async () => {
    const parsed = await inspectIsoBmffMetadata(sampleByteSource(sampleMovie([sampleTrack({ sampleBoxes: [sampleStts(DECODE)] })])), SAMPLE_METADATA_LIMITS);
    expect(parsed.tracks[0]!.sampleTiming).toEqual({ decodeRuns: DECODE, cttsVersion: null, compositionRuns: null, compositionShift: null });
    expect(parsed.tracks[0]!.edits).toBeNull();
  });

  it("preserves uint32 CTTS version zero rather than reinterpreting its high bit", async () => {
    const offsets = [{ sampleCount: 2, offsetTicks: "4294967295" }, { sampleCount: 1, offsetTicks: "0" }];
    const parsed = await inspectIsoBmffMetadata(sampleByteSource(sampleMovie([sampleTrack({ sampleBoxes: [sampleStts(DECODE), sampleCtts(0, offsets)] })])), SAMPLE_METADATA_LIMITS);
    expect(parsed.tracks[0]!.sampleTiming).toEqual({ decodeRuns: DECODE, cttsVersion: 0, compositionRuns: offsets, compositionShift: null });
  });

  it("preserves signed int32 CTTS version one at both integer extrema", async () => {
    const offsets = [{ sampleCount: 1, offsetTicks: "-2147483648" }, { sampleCount: 2, offsetTicks: "2147483647" }];
    const parsed = await inspectIsoBmffMetadata(sampleByteSource(sampleMovie([sampleTrack({ sampleBoxes: [sampleStts(DECODE), sampleCtts(1, offsets)] })])), SAMPLE_METADATA_LIMITS);
    expect(parsed.tracks[0]!.sampleTiming).toEqual({ decodeRuns: DECODE, cttsVersion: 1, compositionRuns: offsets, compositionShift: null });
  });

  it("N06 reads all five original signed cslg fields without inventing a display window", async () => {
    const decodeRuns = [{ sampleCount: 3, deltaTicks: "40" }];
    const compositionRuns = [{ sampleCount: 1, offsetTicks: "0" }, { sampleCount: 1, offsetTicks: "80" }, { sampleCount: 1, offsetTicks: "0" }];
    const parsed = await inspectIsoBmffMetadata(sampleByteSource(sampleMovie([sampleTrack({ sampleBoxes: [sampleCslg(SHIFT), sampleCtts(0, compositionRuns), sampleStts(decodeRuns)] })])), SAMPLE_METADATA_LIMITS);
    expect(parsed.tracks[0]!.sampleTiming).toEqual({ decodeRuns, cttsVersion: 0, compositionRuns, compositionShift: SHIFT });
    expect(parsed.tracks[0]!.edits).toBeNull();
  });

  it("retains signed 64-bit cslg version one facts beyond Number precision", async () => {
    const shift: IsoBmffCompositionShift = {
      version: 1, compositionToDtsShift: "-9007199254740993", leastDecodeToDisplayDelta: "-9223372036854775808",
      greatestDecodeToDisplayDelta: "9223372036854775807", compositionStartTime: "-9007199254740995", compositionEndTime: "9007199254740997",
    };
    const parsed = await inspectIsoBmffMetadata(sampleByteSource(sampleMovie([sampleTrack({ sampleBoxes: [sampleStts(DECODE), sampleCslg(shift)] })])), SAMPLE_METADATA_LIMITS);
    expect(parsed.tracks[0]!.sampleTiming).toEqual({ decodeRuns: DECODE, cttsVersion: null, compositionRuns: null, compositionShift: shift });
  });

  it("binds each stbl to its own original track rather than borrowing the first track", async () => {
    const other = [{ sampleCount: 4, deltaTicks: "48000" }];
    const parsed = await inspectIsoBmffMetadata(sampleByteSource(sampleMovie([
      sampleTrack({ trackId: 11, mediaTimescale: 48000, mediaDuration: 192000, sampleBoxes: [sampleStts(other)] }),
      sampleTrack({ trackId: 7, sampleBoxes: [sampleStts(DECODE)] }),
    ])), SAMPLE_METADATA_LIMITS);
    expect(parsed.tracks.map((track) => ({ trackId: track.trackId, mediaTimescale: track.mediaTimescale, sampleTiming: track.sampleTiming }))).toEqual([
      { trackId: 11, mediaTimescale: "48000", sampleTiming: { decodeRuns: other, cttsVersion: null, compositionRuns: null, compositionShift: null } },
      { trackId: 7, mediaTimescale: "1000", sampleTiming: { decodeRuns: DECODE, cttsVersion: null, compositionRuns: null, compositionShift: null } },
    ]);
  });

  it.each(["stts", "ctts", "cslg"] as const)("retains duplicate_metadata for duplicate %s tables", async (kind) => {
    const duplicate = kind === "stts" ? sampleStts(DECODE) : kind === "ctts" ? sampleCtts(1, [{ sampleCount: 3, offsetTicks: "0" }]) : sampleCslg(SHIFT);
    const bytes = sampleMovie([sampleTrack({ sampleBoxes: [...(kind === "stts" ? [] : [sampleStts(DECODE)]), duplicate, duplicate] })]);
    await expect(inspectIsoBmffMetadata(sampleByteSource(bytes), SAMPLE_METADATA_LIMITS)).rejects.toMatchObject({ code: "duplicate_metadata" });
  });

  it.each(["stts", "ctts"] as const)("rejects a %s entry count beyond the actual payload before an excessive read", async (kind) => {
    const payload = Buffer.alloc(8);
    payload.writeUInt32BE(0xffffffff, 4);
    const reads: SampleRead[] = [];
    const bytes = sampleMovie([sampleTrack({ sampleBoxes: [...(kind === "stts" ? [] : [sampleStts(DECODE)]), sampleAtom(kind, payload)] })]);
    await expect(inspectIsoBmffMetadata(sampleByteSource(bytes, reads), SAMPLE_METADATA_LIMITS)).rejects.toMatchObject({ code: "invalid_box" });
    expect(reads.every((read) => read.length <= SAMPLE_METADATA_LIMITS.metadataBytes)).toBe(true);
  });

  it.each(["stts", "ctts", "cslg"] as const)("rejects unsupported %s full-box versions without guessing a field width", async (kind) => {
    const unsupported = kind === "stts" ? sampleStts(DECODE) : kind === "ctts" ? sampleCtts(1, [{ sampleCount: 3, offsetTicks: "0" }]) : sampleCslg(SHIFT);
    unsupported[8] = 2;
    const bytes = sampleMovie([sampleTrack({ sampleBoxes: [...(kind === "stts" ? [] : [sampleStts(DECODE)]), unsupported] })]);
    await expect(inspectIsoBmffMetadata(sampleByteSource(bytes), SAMPLE_METADATA_LIMITS)).rejects.toMatchObject({ code: "unsupported_version" });
  });

  it("rejects stts version one rather than confusing it with the ctts version domain", async () => {
    const unsupported = sampleStts(DECODE);
    unsupported[8] = 1;
    const bytes = sampleMovie([sampleTrack({ sampleBoxes: [unsupported] })]);
    await expect(inspectIsoBmffMetadata(sampleByteSource(bytes), SAMPLE_METADATA_LIMITS)).rejects.toMatchObject({ code: "unsupported_version" });
  });

  it.each([0, 1] as const)("rejects incomplete cslg version %s fields", async (version) => {
    const payload = Buffer.alloc(version === 0 ? 23 : 43);
    payload[0] = version;
    const bytes = sampleMovie([sampleTrack({ sampleBoxes: [sampleStts(DECODE), sampleAtom("cslg", payload)] })]);
    await expect(inspectIsoBmffMetadata(sampleByteSource(bytes), SAMPLE_METADATA_LIMITS)).rejects.toMatchObject({ code: "invalid_box" });
  });

  it("charges timing-table reads to the original cumulative byte ceiling", async () => {
    const reads: SampleRead[] = [];
    const bytes = sampleMovie([sampleTrack({ sampleBoxes: [sampleStts(Array.from({ length: 64 }, () => ({ sampleCount: 1, deltaTicks: "40" })))] })]);
    await expect(inspectIsoBmffMetadata(sampleByteSource(bytes, reads), { ...SAMPLE_METADATA_LIMITS, metadataBytes: 320 })).rejects.toMatchObject({ code: "resource_limit" });
    expect(reads.reduce((sum, read) => sum + read.length, 0)).toBeLessThanOrEqual(320);
  });

  it("charges minf/stbl/timing children to the original box-count ceiling", async () => {
    const bytes = sampleMovie([sampleTrack({ sampleBoxes: [sampleStts(DECODE), sampleCtts(1, [{ sampleCount: 3, offsetTicks: "0" }])] })]);
    await expect(inspectIsoBmffMetadata(sampleByteSource(bytes), { ...SAMPLE_METADATA_LIMITS, boxCount: 9 })).rejects.toMatchObject({ code: "resource_limit" });
  });

  it("skips unknown stbl payloads while reading the real timing tables", async () => {
    const reads: SampleRead[] = [];
    const bytes = sampleMovie([sampleTrack({ sampleBoxes: [sampleAtom("junk", Buffer.alloc(4096)), sampleStts(DECODE)] })]);
    const start = BigInt(bytes.indexOf(Buffer.from("junk")) + 4);
    const parsed = await inspectIsoBmffMetadata(sampleByteSource(bytes, reads), SAMPLE_METADATA_LIMITS);
    expect(parsed.tracks[0]!.sampleTiming).toEqual({ decodeRuns: DECODE, cttsVersion: null, compositionRuns: null, compositionShift: null });
    expect(reads.some((read) => read.offset >= start && read.offset < start + 4096n)).toBe(false);
  });

  it("reads actual local sample tables through the existing inspectIsoBmffFile owner", async () => {
    const directory = await mkdtemp(join(tmpdir(), "iso-sample-timing-"));
    try {
      const file = join(directory, "source.mp4");
      await writeFile(file, sampleMovie([sampleTrack({ sampleBoxes: [sampleStts(DECODE)] })]));
      expect((await inspectIsoBmffFile(file, SAMPLE_METADATA_LIMITS)).tracks[0]!.sampleTiming).toEqual({ decodeRuns: DECODE, cttsVersion: null, compositionRuns: null, compositionShift: null });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("preserves arbitrary legal binary CTTS signedness and compressed counts", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 100 }), fc.integer({ min: -2147483648, max: 2147483647 }), fc.integer({ min: 0, max: 4294967295 }), async (sampleCount, signed, unsigned) => {
      const decodeRuns = [{ sampleCount, deltaTicks: "4294967295" }];
      for (const [version, value] of [[0, unsigned], [1, signed]] as const) {
        const compositionRuns = [{ sampleCount, offsetTicks: String(value) }];
        const parsed = await inspectIsoBmffMetadata(sampleByteSource(sampleMovie([sampleTrack({ sampleBoxes: [sampleStts(decodeRuns), sampleCtts(version, compositionRuns)] })])), SAMPLE_METADATA_LIMITS);
        expect(parsed.tracks[0]!.sampleTiming).toEqual({ decodeRuns, cttsVersion: version, compositionRuns, compositionShift: null });
      }
    }), { numRuns: 40 });
  });
});
