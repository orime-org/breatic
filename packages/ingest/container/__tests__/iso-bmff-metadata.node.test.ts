// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { inspectIsoBmffFile, inspectIsoBmffMetadata, type IsoBmffByteSource, type IsoBmffEdit } from "@ingest/container/iso-bmff-metadata.js";

const LIMITS = { metadataBytes: 16384, boxCount: 64 };
const EDIT: IsoBmffEdit = { segmentDurationMovieTicks: "1000", mediaTimeTrackTicks: "4096", mediaRateFixed16_16: "65536" };
interface ReadRequest { offset: bigint; length: number }
interface MovieOptions {
  version?: 0 | 1;
  movieScale?: number;
  mediaScale?: number;
  movieDuration?: bigint;
  mediaDuration?: bigint;
  edits?: IsoBmffEdit[] | null;
  trackId?: number;
  extended?: boolean;
}

/** Encode one fixed source atom without using the parser under test.
 * @throws {RangeError} When the test requests an unrepresentable size.
 */
function atom(kind: string, body: Uint8Array, extended = false, zero = false): Buffer {
  const header = Buffer.alloc(extended ? 16 : 8);
  header.writeUInt32BE(zero ? 0 : extended ? 1 : body.length + 8, 0);
  header.write(kind, 4, 4, "ascii");
  if (extended) header.writeBigUInt64BE(BigInt(body.length + 16), 8);
  return Buffer.concat([header, body]);
}

/** Create standard v0/v1 fields at the format's defined byte positions.
 * @throws {RangeError} When an integer is outside that version's wire domain.
 */
function headers(options: MovieOptions = {}): { mvhd: Buffer; tkhd: Buffer; mdhd: Buffer; elst: Buffer | null } {
  const version = options.version ?? 0;
  const mvhd = Buffer.alloc(version === 1 ? 112 : 100);
  const tkhd = Buffer.alloc(version === 1 ? 96 : 84);
  const mdhd = Buffer.alloc(version === 1 ? 36 : 24);
  for (const header of [mvhd, tkhd, mdhd]) header[0] = version;
  tkhd.writeUIntBE(3, 1, 3);
  mvhd.writeUInt32BE(options.movieScale ?? 1000, version === 1 ? 20 : 12);
  mdhd.writeUInt32BE(options.mediaScale ?? 16384, version === 1 ? 20 : 12);
  tkhd.writeUInt32BE(options.trackId ?? 7, version === 1 ? 20 : 12);
  const duration = options.movieDuration ?? 1000n;
  const mediaDuration = options.mediaDuration ?? 34816n;
  if (version === 1) {
    mvhd.writeBigUInt64BE(duration, 24); tkhd.writeBigUInt64BE(duration, 28); mdhd.writeBigUInt64BE(mediaDuration, 24);
  } else {
    mvhd.writeUInt32BE(Number(duration), 16); tkhd.writeUInt32BE(Number(duration), 20); mdhd.writeUInt32BE(Number(mediaDuration), 16);
  }
  const edits = options.edits === undefined ? [EDIT] : options.edits;
  let elst: Buffer | null = null;
  if (edits !== null) {
    elst = Buffer.alloc(8 + edits.length * (version === 1 ? 20 : 12)); elst[0] = version; elst.writeUInt32BE(edits.length, 4);
    for (const [index, edit] of edits.entries()) {
      const offset = 8 + index * (version === 1 ? 20 : 12);
      if (version === 1) {
        elst.writeBigUInt64BE(BigInt(edit.segmentDurationMovieTicks), offset);
        elst.writeBigInt64BE(BigInt(edit.mediaTimeTrackTicks), offset + 8);
        elst.writeInt32BE(Number(edit.mediaRateFixed16_16), offset + 16);
      } else {
        elst.writeUInt32BE(Number(edit.segmentDurationMovieTicks), offset);
        elst.writeInt32BE(Number(edit.mediaTimeTrackTicks), offset + 4);
        elst.writeInt32BE(Number(edit.mediaRateFixed16_16), offset + 8);
      }
    }
  }
  return { mvhd, tkhd, mdhd, elst };
}

/** Assemble only the fixed container layout; expected facts remain explicit in assertions.
 * @throws {RangeError} When a fixture field cannot be encoded.
 */
function movie(options: MovieOptions = {}): Buffer {
  const fields = headers(options);
  const track = atom("trak", Buffer.concat([
    atom("tkhd", fields.tkhd, options.extended), atom("mdia", atom("mdhd", fields.mdhd, options.extended)),
    ...(fields.elst === null ? [] : [atom("edts", atom("elst", fields.elst, options.extended))]),
  ]));
  return atom("moov", Buffer.concat([atom("mvhd", fields.mvhd, options.extended), track]), options.extended);
}

/** Expose actual fixed bytes and record every read requested by the metadata reader.
 * @throws {never} Never.
 */
function byteSource(bytes: Uint8Array, reads: ReadRequest[] = []): IsoBmffByteSource {
  return { size: BigInt(bytes.length), read: async (offset, length) => { reads.push({ offset, length }); return bytes.subarray(Number(offset), Number(offset) + length); } };
}

const EXPECTED = { movieTimescale: "1000", movieDurationTicks: "1000", tracks: [{ trackId: 7, trackFlags: 3, durationMovieTicks: "1000", mediaTimescale: "16384", mediaDurationTicks: "34816", edits: [EDIT] }] };

describe("bounded owned ISO-BMFF integer metadata, without a decoder", () => {
  it("reads identified v0 movie/track clocks and complete edits", async () => {
    expect(await inspectIsoBmffMetadata(byteSource(movie()), LIMITS)).toEqual(EXPECTED);
  });
  it("preserves v1 uint64 durations, signed media time and the whole fractional rate", async () => {
    const edit = { segmentDurationMovieTicks: "9007199254740993", mediaTimeTrackTicks: "-9007199254740993", mediaRateFixed16_16: "32768" };
    expect(await inspectIsoBmffMetadata(byteSource(movie({ version: 1, movieDuration: 18446744073709551615n, mediaDuration: 9007199254740997n, edits: [edit] })), LIMITS)).toEqual({
      movieTimescale: "1000", movieDurationTicks: "18446744073709551615", tracks: [{ trackId: 7, trackFlags: 3, durationMovieTicks: "18446744073709551615", mediaTimescale: "16384", mediaDurationTicks: "9007199254740997", edits: [edit] }],
    });
  });
  it("keeps every edit, including empty, repeated, backward and non-rate-one facts", async () => {
    const edits = [{ ...EDIT, segmentDurationMovieTicks: "250", mediaTimeTrackTicks: "-1" }, EDIT, { ...EDIT, mediaTimeTrackTicks: "20480" }, EDIT, { ...EDIT, mediaRateFixed16_16: "-65536" }];
    expect((await inspectIsoBmffMetadata(byteSource(movie({ edits })), LIMITS)).tracks[0]!.edits).toEqual(edits);
  });
  it("distinguishes an absent edit list from a present empty edit list", async () => {
    expect((await inspectIsoBmffMetadata(byteSource(movie({ edits: null })), LIMITS)).tracks[0]!.edits).toBeNull();
    expect((await inspectIsoBmffMetadata(byteSource(movie({ edits: [] })), LIMITS)).tracks[0]!.edits).toEqual([]);
  });
  it("binds clocks to their own track IDs independent of child order", async () => {
    const one = headers(); const two = headers({ trackId: 11, mediaScale: 48000, edits: [{ ...EDIT, mediaTimeTrackTicks: "1024" }] });
    const bytes = atom("moov", Buffer.concat([atom("mvhd", one.mvhd), atom("trak", Buffer.concat([atom("mdia", atom("mdhd", two.mdhd)), atom("edts", atom("elst", two.elst!)), atom("tkhd", two.tkhd)])), atom("trak", Buffer.concat([atom("tkhd", one.tkhd), atom("mdia", atom("mdhd", one.mdhd))]))]));
    expect((await inspectIsoBmffMetadata(byteSource(bytes), LIMITS)).tracks).toEqual([
      { ...EXPECTED.tracks[0], trackId: 11, mediaTimescale: "48000", edits: [{ ...EDIT, mediaTimeTrackTicks: "1024" }] }, { ...EXPECTED.tracks[0], edits: null },
    ]);
  });
  it("reads valid extended-size boxes without changing facts", async () => {
    expect(await inspectIsoBmffMetadata(byteSource(movie({ extended: true })), LIMITS)).toEqual(EXPECTED);
  });
  it("skips unknown payloads and a size-zero final mdat within the actual source", async () => {
    const reads: ReadRequest[] = []; const metadata = movie(); const bytes = Buffer.concat([atom("free", Buffer.alloc(4096)), metadata, atom("mdat", Buffer.alloc(1024), false, true)]);
    expect(await inspectIsoBmffMetadata(byteSource(bytes, reads), LIMITS)).toEqual(EXPECTED);
    expect(reads.every((read) => read.length <= LIMITS.metadataBytes && read.offset + BigInt(read.length) <= BigInt(bytes.length))).toBe(true);
    expect(reads.some((read) => read.offset > 8n && read.offset < 4104n)).toBe(false);
  });
  it("skips a virtual media atom beyond 2^53 using exact offsets", async () => {
    const mediaSize = 9007199254741011n; const prefix = Buffer.alloc(16); prefix.writeUInt32BE(1); prefix.write("mdat", 4); prefix.writeBigUInt64BE(mediaSize, 8); const metadata = movie(); const reads: ReadRequest[] = [];
    const source: IsoBmffByteSource = { size: mediaSize + BigInt(metadata.length), read: async (offset, length) => {
      reads.push({ offset, length });
      if (offset < 16n) return prefix.subarray(Number(offset), Number(offset) + length);
      if (offset >= mediaSize) return metadata.subarray(Number(offset - mediaSize), Number(offset - mediaSize) + length);
      throw new Error("The reader entered a media payload");
    } };
    expect(await inspectIsoBmffMetadata(source, LIMITS)).toEqual(EXPECTED);
    expect(reads.some((read) => read.offset === mediaSize)).toBe(true);
  });
  it("reads a real local file with the same bounded metadata contract", async () => {
    const directory = await mkdtemp(join(tmpdir(), "iso-metadata-red-"));
    try { const file = join(directory, "input.mp4"); await writeFile(file, Buffer.concat([atom("mdat", Buffer.alloc(65536)), movie()])); expect(await inspectIsoBmffFile(file, LIMITS)).toEqual(EXPECTED); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("rejects invalid caller budgets before any source IO", async () => {
    const reads: ReadRequest[] = [];
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(inspectIsoBmffMetadata(byteSource(movie(), reads), { ...LIMITS, metadataBytes: invalid })).rejects.toMatchObject({ code: "invalid_limits" });
      await expect(inspectIsoBmffMetadata(byteSource(movie(), reads), { ...LIMITS, boxCount: invalid })).rejects.toMatchObject({ code: "invalid_limits" });
    }
    expect(reads).toEqual([]);
  });
  it("enforces cumulative metadata bytes before requesting excess data", async () => {
    const reads: ReadRequest[] = [];
    await expect(inspectIsoBmffMetadata(byteSource(movie(), reads), { ...LIMITS, metadataBytes: 8 })).rejects.toMatchObject({ code: "resource_limit" });
    expect(reads.reduce((total, read) => total + read.length, 0)).toBeLessThanOrEqual(8);
  });
  it("enforces the box-count budget across the whole traversal", async () => {
    await expect(inspectIsoBmffMetadata(byteSource(movie()), { ...LIMITS, boxCount: 1 })).rejects.toMatchObject({ code: "resource_limit" });
  });
  it("rejects an ordinary box size smaller than its header", async () => {
    const bytes = Buffer.alloc(8); bytes.writeUInt32BE(4); bytes.write("moov", 4);
    await expect(inspectIsoBmffMetadata(byteSource(bytes), LIMITS)).rejects.toMatchObject({ code: "invalid_box" });
  });
  it("rejects an extended box size smaller than its full header", async () => {
    const bytes = Buffer.alloc(16); bytes.writeUInt32BE(1); bytes.write("moov", 4); bytes.writeBigUInt64BE(12n, 8);
    await expect(inspectIsoBmffMetadata(byteSource(bytes), LIMITS)).rejects.toMatchObject({ code: "invalid_box" });
  });
  it("rejects any child crossing its parent boundary", async () => {
    const child = Buffer.alloc(8); child.writeUInt32BE(1024); child.write("trak", 4);
    await expect(inspectIsoBmffMetadata(byteSource(atom("moov", Buffer.concat([atom("mvhd", headers().mvhd), child]))), LIMITS)).rejects.toMatchObject({ code: "invalid_box" });
  });
  it("rejects a declared 64-bit extent beyond the actual source", async () => {
    const bytes = Buffer.alloc(16); bytes.writeUInt32BE(1); bytes.write("mdat", 4); bytes.writeBigUInt64BE(18446744073709551615n, 8);
    await expect(inspectIsoBmffMetadata(byteSource(bytes), LIMITS)).rejects.toMatchObject({ code: "invalid_box" });
  });
  it("rejects truncated reads rather than synthesizing zero-filled facts", async () => {
    await expect(inspectIsoBmffMetadata({ size: 100n, read: async () => new Uint8Array(1) }, LIMITS)).rejects.toMatchObject({ code: "truncated_read" });
  });
  it("retains an actual source IO error as its failure cause", async () => {
    const cause = new Error("Physical read failed");
    await expect(inspectIsoBmffMetadata({ size: 100n, read: async () => { throw cause; } }, LIMITS)).rejects.toMatchObject({ code: "read_failed", cause });
  });
  it("rejects an edit count that exceeds the complete elst payload", async () => {
    const fields = headers(); fields.elst!.writeUInt32BE(100, 4);
    const bytes = atom("moov", Buffer.concat([atom("mvhd", fields.mvhd), atom("trak", Buffer.concat([atom("tkhd", fields.tkhd), atom("mdia", atom("mdhd", fields.mdhd)), atom("edts", atom("elst", fields.elst!))]))]));
    await expect(inspectIsoBmffMetadata(byteSource(bytes), LIMITS)).rejects.toMatchObject({ code: "invalid_box" });
  });
  it("rejects duplicate required movie facts instead of choosing a winner", async () => {
    const fields = headers();
    await expect(inspectIsoBmffMetadata(byteSource(atom("moov", Buffer.concat([atom("mvhd", fields.mvhd), atom("mvhd", fields.mvhd)]))), LIMITS)).rejects.toMatchObject({ code: "duplicate_metadata" });
  });
  it("rejects duplicate track identities", async () => {
    const fields = headers(); const track = atom("trak", Buffer.concat([atom("tkhd", fields.tkhd), atom("mdia", atom("mdhd", fields.mdhd))]));
    await expect(inspectIsoBmffMetadata(byteSource(atom("moov", Buffer.concat([atom("mvhd", fields.mvhd), track, track]))), LIMITS)).rejects.toMatchObject({ code: "duplicate_metadata" });
  });
  it("rejects duplicate edit lists without losing the first schedule", async () => {
    const fields = headers(); const edit = atom("elst", fields.elst!);
    const bytes = atom("moov", Buffer.concat([atom("mvhd", fields.mvhd), atom("trak", Buffer.concat([atom("tkhd", fields.tkhd), atom("mdia", atom("mdhd", fields.mdhd)), atom("edts", Buffer.concat([edit, edit]))]))]));
    await expect(inspectIsoBmffMetadata(byteSource(bytes), LIMITS)).rejects.toMatchObject({ code: "duplicate_metadata" });
  });
  it("rejects missing movie and media clocks explicitly", async () => {
    await expect(inspectIsoBmffMetadata(byteSource(atom("moov", atom("trak", atom("tkhd", headers().tkhd)))), LIMITS)).rejects.toMatchObject({ code: "missing_metadata" });
    await expect(inspectIsoBmffMetadata(byteSource(atom("moov", Buffer.concat([atom("mvhd", headers().mvhd), atom("trak", atom("tkhd", headers().tkhd))]))), LIMITS)).rejects.toMatchObject({ code: "missing_metadata" });
  });
  it("rejects versions it cannot interpret without guessing field widths", async () => {
    const fields = headers(); fields.mvhd[0] = 2;
    await expect(inspectIsoBmffMetadata(byteSource(atom("moov", atom("mvhd", fields.mvhd))), LIMITS)).rejects.toMatchObject({ code: "unsupported_version" });
  });
  it("rejects zero clock divisors", async () => {
    await expect(inspectIsoBmffMetadata(byteSource(movie({ movieScale: 0 })), LIMITS)).rejects.toMatchObject({ code: "invalid_clock" });
    await expect(inspectIsoBmffMetadata(byteSource(movie({ mediaScale: 0 })), LIMITS)).rejects.toMatchObject({ code: "invalid_clock" });
  });
  it("does not silently select one of multiple movie headers", async () => {
    await expect(inspectIsoBmffMetadata(byteSource(Buffer.concat([movie(), movie()])), LIMITS)).rejects.toMatchObject({ code: "unsupported_structure" });
  });
  it("preserves arbitrary actual 64-bit edits and clocks without Number rounding", async () => {
    await fc.assert(fc.asyncProperty(fc.bigInt({ min: 0n, max: 18446744073709551615n }), fc.bigInt({ min: -9223372036854775808n, max: 9223372036854775807n }), fc.integer({ min: -2147483648, max: 2147483647 }), async (duration, mediaTime, rate) => {
      const edit = { segmentDurationMovieTicks: duration.toString(), mediaTimeTrackTicks: mediaTime.toString(), mediaRateFixed16_16: rate.toString() };
      const parsed = await inspectIsoBmffMetadata(byteSource(movie({ version: 1, movieDuration: duration, mediaDuration: duration, edits: [edit] })), LIMITS);
      expect(parsed.movieDurationTicks).toBe(duration.toString()); expect(parsed.tracks[0]!.mediaDurationTicks).toBe(duration.toString()); expect(parsed.tracks[0]!.edits).toEqual([edit]);
    }), { numRuns: 40 });
  });
  it("keeps unknown atom payloads outside all bounded reads", async () => {
    await fc.assert(fc.asyncProperty(fc.uint8Array({ maxLength: 256 }), async (payload) => {
      const reads: ReadRequest[] = []; const prefix = atom("junk", payload); const bytes = Buffer.concat([prefix, movie()]);
      expect(await inspectIsoBmffMetadata(byteSource(bytes, reads), LIMITS)).toEqual(EXPECTED);
      expect(reads.some((read) => read.offset >= 8n && read.offset < BigInt(prefix.length))).toBe(false);
      expect(reads.reduce((total, read) => total + read.length, 0)).toBeLessThanOrEqual(LIMITS.metadataBytes);
    }), { numRuns: 30 });
  });
  it("never accepts a truncated prefix as complete movie metadata", async () => {
    const bytes = movie();
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: bytes.length - 1 }), async (length) => {
      await expect(inspectIsoBmffMetadata(byteSource(bytes.subarray(0, length)), LIMITS)).rejects.toHaveProperty("code");
    }), { numRuns: 30 });
  });
});
