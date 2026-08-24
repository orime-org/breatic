// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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

/**
 * Build a PNG header declaring the given dimensions.
 * @param width - Width to write into IHDR.
 * @param height - Height to write into IHDR.
 * @param type - Chunk type to claim, for the malformed cases.
 * @returns The first 24 bytes of such a file, plus a little padding.
 */
function pngHeader(width: number, height: number, type = "IHDR"): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(13);
  const dims = Buffer.alloc(8);
  dims.writeUInt32BE(width, 0);
  dims.writeUInt32BE(height, 4);
  return Buffer.concat([
    SIGNATURE,
    length,
    Buffer.from(type, "ascii"),
    dims,
    Buffer.alloc(5), // rest of IHDR: bit depth, colour type, ...
  ]);
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
    expect(readPngSize(pngHeader(512, 512, "tEXt"))).toBeNull();
  });

  it("refuses a zero dimension", () => {
    expect(readPngSize(pngHeader(0, 512))).toBeNull();
    expect(readPngSize(pngHeader(512, 0))).toBeNull();
  });
});
