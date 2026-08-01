// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Reading a PNG header without trusting it.
 *
 * This is the parser that stands between an uploaded avatar and the dimension
 * rule, so what matters is not only that it reads a good file correctly but
 * that it refuses everything else without reaching past the bytes it was
 * given. Every case below is a file the endpoint can actually receive.
 */

import { describe, it, expect } from "vitest";
import { readPngSize } from "@server/modules/studio/png-size.js";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Overrides for the header fields a malformed-case test wants to bend. */
interface HeaderOverrides {
  /** Chunk type tag, for the "first chunk is not IHDR" cases. */
  type?: Buffer;
  /** What the chunk claims its payload length is. IHDR's is fixed at 13. */
  declaredLength?: number;
  /** Bits per channel. Only 8 is produced by a canvas re-encode. */
  bitDepth?: number;
  /** 0 for a normal image, 1 for Adam7 interlacing. */
  interlace?: number;
}

/**
 * Build a PNG header declaring the given dimensions.
 *
 * Defaults describe what our own crop dialog emits — 8 bits per channel, RGBA,
 * no interlacing — so a test that bends one field is bending exactly that one.
 * @param width - Width to write into IHDR.
 * @param height - Height to write into IHDR.
 * @param o - Fields to bend away from a well-formed header.
 * @returns The bytes of such a file's header, plus a little padding.
 */
function pngHeader(
  width: number,
  height: number,
  o: HeaderOverrides = {},
): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(o.declaredLength ?? 13);
  const payload = Buffer.alloc(13);
  payload.writeUInt32BE(width, 0);
  payload.writeUInt32BE(height, 4);
  payload[8] = o.bitDepth ?? 8;
  payload[9] = 6; // colour type: RGBA
  payload[10] = 0; // compression: deflate, the only value the format defines
  payload[11] = 0; // filter: the only value the format defines
  payload[12] = o.interlace ?? 0;
  return Buffer.concat([
    SIGNATURE,
    length,
    o.type ?? Buffer.from("IHDR", "ascii"),
    payload,
    Buffer.alloc(4), // IHDR's CRC, which a real file always carries
  ]);
}

/**
 * Build one PNG chunk. The CRC is left zero — nothing here validates it, and a
 * hostile file would not have a correct one either.
 * @param type - Four-character chunk type.
 * @param payload - The chunk's bytes.
 * @returns Length, type, payload and a placeholder CRC.
 */
function chunk(type: string, payload: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  return Buffer.concat([
    length,
    Buffer.from(type, "ascii"),
    payload,
    Buffer.alloc(4),
  ]);
}

/**
 * Build an ANIMATED PNG with a given amount of filler before its acTL chunk.
 *
 * The filler is what defeats a sniffer with a chunk budget: push acTL past the
 * budget and the file is reported as a still PNG.
 * @param fillerChunks - How many tEXt chunks to bury acTL behind.
 * @returns The file bytes.
 */
function animatedPng(fillerChunks: number): Buffer {
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(2, 0); // frame count
  const parts = [pngHeader(512, 512)];
  for (let i = 0; i < fillerChunks; i += 1) {
    parts.push(chunk("tEXt", Buffer.from(`k${i}\0v`)));
  }
  parts.push(chunk("acTL", actl), chunk("IDAT", Buffer.alloc(8)), chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/**
 * Build a still PNG carrying the given ancillary chunks between IHDR and IDAT.
 * @param types - Chunk types a legitimate encoder might include.
 * @returns The file bytes.
 */
function stillPngWithChunks(types: readonly string[]): Buffer {
  const parts = [pngHeader(512, 512)];
  for (const t of types) parts.push(chunk(t, Buffer.from([0x01])));
  parts.push(chunk("IDAT", Buffer.alloc(8)), chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

describe("readPngSize", () => {
  it("reads the dimensions a real avatar declares", () => {
    expect(readPngSize(pngHeader(512, 512))).toEqual({
      width: 512,
      height: 512,
    });
  });

  it("reads a non-square size rather than normalising it", () => {
    // The caller decides what is acceptable; this only reports.
    expect(readPngSize(pngHeader(800, 600))).toEqual({
      width: 800,
      height: 600,
    });
  });

  it("reads the huge dimensions a decompression bomb declares", () => {
    // The whole point: a file this small claiming 25000² is exactly what the
    // byte cap lets through and the dimension rule has to catch.
    expect(readPngSize(pngHeader(25000, 25000))).toEqual({
      width: 25000,
      height: 25000,
    });
  });

  it("refuses bytes that are not a PNG", () => {
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(32),
    ]);
    expect(readPngSize(jpeg)).toBeNull();
  });

  it("refuses a file too short to hold a header", () => {
    expect(readPngSize(SIGNATURE)).toBeNull();
    expect(readPngSize(Buffer.alloc(0))).toBeNull();
    expect(readPngSize(pngHeader(512, 512).subarray(0, 23))).toBeNull();
  });

  it("refuses a PNG whose first chunk is not IHDR", () => {
    // The format requires IHDR first. A file that puts something else there is
    // malformed, and reading dimensions from a fixed offset anyway would be
    // reading whatever that other chunk happens to contain.
    expect(
      readPngSize(pngHeader(512, 512, { type: Buffer.from("tEXt", "ascii") })),
    ).toBeNull();
  });

  it("refuses a chunk tag that only looks like IHDR once the high bit is dropped", () => {
    // Comparing the tag by decoding it as "ascii" is a trap: Node's ascii
    // decoder masks bit 7, so 0xC9 comes back as "I". Fifteen other byte
    // quadruples decode to the string "IHDR" the same way, and each is a
    // different chunk as far as the format is concerned — bit 5 of each byte
    // carries meaning (ancillary, private, safe-to-copy). The tag is bytes,
    // so it has to be compared as bytes.
    const masked = Buffer.from([0x49 | 0x80, 0x48, 0x44, 0x52]);
    expect(masked.toString("ascii")).toBe("IHDR"); // the trap, pinned
    expect(readPngSize(pngHeader(512, 512, { type: masked }))).toBeNull();
  });

  it("refuses an IHDR that declares a length other than 13", () => {
    // The format fixes IHDR's payload at 13 bytes. A file claiming anything
    // else is malformed, and believing the dimensions inside it means trusting
    // a header that already contradicts the spec about its own shape.
    expect(readPngSize(pngHeader(512, 512, { declaredLength: 12 }))).toBeNull();
    expect(readPngSize(pngHeader(512, 512, { declaredLength: 25 }))).toBeNull();
    expect(
      readPngSize(pngHeader(512, 512, { declaredLength: 0xffffffff })),
    ).toBeNull();
  });

  it("refuses 16 bits per channel — same grid, twice the memory to decode", () => {
    // Dimensions alone do not bound decode cost. At 16 bits a 512x512 RGBA
    // frame is 2 MiB decoded instead of 1 MiB, for a file that passes every
    // other check. A canvas re-encode is always 8, so nothing we produce is
    // turned away.
    expect(readPngSize(pngHeader(512, 512, { bitDepth: 16 }))).toBeNull();
  });

  it("refuses an interlaced PNG — Adam7 is seven passes over the same grid", () => {
    expect(readPngSize(pngHeader(512, 512, { interlace: 1 }))).toBeNull();
  });

  it("refuses a zero dimension", () => {
    expect(readPngSize(pngHeader(0, 512))).toBeNull();
    expect(readPngSize(pngHeader(512, 0))).toBeNull();
  });
  it("refuses an animated PNG however far the acTL chunk is buried", () => {
    // The whitelist keeps animated PNG out by asking a sniffer what the file
    // is, and that sniffer gives up after a fixed number of chunks — so a file
    // that puts enough filler before acTL is reported as a still PNG and walks
    // straight through. Deciding it here instead means walking the chunk chain
    // ourselves, with no budget to run out of.
    expect(readPngSize(animatedPng(0))).toBeNull();
    expect(readPngSize(animatedPng(511))).toBeNull();
    expect(readPngSize(animatedPng(2000))).toBeNull();
  });

  it("accepts a still PNG that carries ancillary chunks", () => {
    // Walking the chain must not turn away metadata a legitimate encoder adds.
    expect(readPngSize(stillPngWithChunks(["sRGB", "gAMA", "tEXt"]))).toEqual({
      width: 512,
      height: 512,
    });
  });

  it("refuses a chunk chain whose declared length runs past the file", () => {
    // Walking the chain means reading lengths from the file being judged. A
    // length that points past the end is the file lying about its own shape,
    // and following it would read whatever happens to be in memory next.
    const bytes = stillPngWithChunks([]);
    bytes.writeUInt32BE(0xfffffff0, 8 + 4 + 4 + 13 + 4); // first chunk after IHDR
    expect(readPngSize(bytes)).toBeNull();
  });
});
