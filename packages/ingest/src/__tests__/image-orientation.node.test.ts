// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import { readImageOrientation, type RangeReader } from "@ingest/image-orientation.js";

/** A TIFF block holding one IFD0 entry: Orientation = `value`. */
function tiff(value: number, littleEndian = false): Uint8Array {
  const out = new Uint8Array(26);
  const view = new DataView(out.buffer);
  out.set(littleEndian ? [0x49, 0x49] : [0x4d, 0x4d], 0);
  view.setUint16(2, 42, littleEndian);
  view.setUint32(4, 8, littleEndian);
  view.setUint16(8, 1, littleEndian); // one entry
  view.setUint16(10, 0x0112, littleEndian); // Orientation
  view.setUint16(12, 3, littleEndian); // SHORT
  view.setUint32(14, 1, littleEndian);
  view.setUint16(18, value, littleEndian);
  view.setUint32(22, 0, littleEndian); // no next IFD
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

function u16be(n: number): Uint8Array {
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
}

function u32be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function u32le(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}

/** A JPEG whose APP1 carries `exif`, after an APP0 so APP1 is not first. */
function jpeg(exif: Uint8Array | null): Uint8Array {
  const app0 = concat(new Uint8Array([0xff, 0xe0]), u16be(16), ascii("JFIF\0"), new Uint8Array(9));
  const app1 =
    exif === null
      ? new Uint8Array(0)
      : concat(new Uint8Array([0xff, 0xe1]), u16be(2 + 6 + exif.length), ascii("Exif\0\0"), exif);
  const sos = concat(new Uint8Array([0xff, 0xda]), u16be(8), new Uint8Array(6), new Uint8Array(1000));
  return concat(new Uint8Array([0xff, 0xd8]), app0, app1, sos, new Uint8Array([0xff, 0xd9]));
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  return concat(u32be(data.length), ascii(type), data, new Uint8Array(4));
}

function png(exif: Uint8Array | null): Uint8Array {
  return concat(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", new Uint8Array(13)),
    exif === null ? new Uint8Array(0) : pngChunk("eXIf", exif),
    pngChunk("IDAT", new Uint8Array(500)),
    pngChunk("IEND", new Uint8Array(0)),
  );
}

function riffChunk(type: string, data: Uint8Array): Uint8Array {
  const padded = data.length % 2 === 1 ? concat(data, new Uint8Array(1)) : data;
  return concat(ascii(type), u32le(data.length), padded);
}

/** A WebP whose EXIF chunk sits after `imageBytes` of image data, as the spec orders it. */
function webp(options: {
  exif: Uint8Array | null;
  exifFlag: boolean;
  imageBytes: number;
  lossless: boolean;
  exifPrefix?: boolean;
}): Uint8Array {
  const vp8x = new Uint8Array(10);
  vp8x[0] = options.exifFlag ? 0x08 : 0;
  const image = riffChunk(options.lossless ? "VP8L" : "VP8 ", new Uint8Array(options.imageBytes));
  const exif =
    options.exif === null
      ? new Uint8Array(0)
      : riffChunk("EXIF", options.exifPrefix === true ? concat(ascii("Exif\0\0"), options.exif) : options.exif);
  const body = concat(ascii("WEBP"), riffChunk("VP8X", vp8x), image, exif);
  return concat(ascii("RIFF"), u32le(body.length), body);
}

/** A simple WebP: no VP8X, just the image chunk. */
function simpleWebp(lossless: boolean): Uint8Array {
  const body = concat(ascii("WEBP"), riffChunk(lossless ? "VP8L" : "VP8 ", new Uint8Array(200)));
  return concat(ascii("RIFF"), u32le(body.length), body);
}

interface CountingReader extends RangeReader {
  calls: Array<[number, number]>;
}

function readerOf(bytes: Uint8Array): CountingReader {
  const calls: Array<[number, number]> = [];
  const read = async (offset: number, length: number): Promise<Uint8Array> => {
    calls.push([offset, length]);
    return bytes.slice(offset, offset + length);
  };
  return Object.assign(read, { calls });
}

const failing: RangeReader = async () => {
  throw new Error("R2 range read failed");
};

describe("readImageOrientation", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])("reads orientation %i from a big-endian JPEG", async (value) => {
    await expect(readImageOrientation(readerOf(jpeg(tiff(value))), "image/jpeg")).resolves.toEqual({
      orientation: value,
      lossless: false,
    });
  });

  it("reads a little-endian JPEG", async () => {
    await expect(readImageOrientation(readerOf(jpeg(tiff(6, true))), "image/jpeg")).resolves.toEqual({
      orientation: 6,
      lossless: false,
    });
  });

  it("answers 1 for a JPEG with no EXIF", async () => {
    await expect(readImageOrientation(readerOf(jpeg(null)), "image/jpeg")).resolves.toEqual({
      orientation: 1,
      lossless: false,
    });
  });

  it("answers 1 for a JPEG whose EXIF is cut short", async () => {
    const cut = jpeg(tiff(6)).slice(0, 30);
    await expect(readImageOrientation(readerOf(cut), "image/jpeg")).resolves.toEqual({
      orientation: 1,
      lossless: false,
    });
  });

  it("answers 1 for an orientation value outside 1-8", async () => {
    await expect(readImageOrientation(readerOf(jpeg(tiff(9))), "image/jpeg")).resolves.toEqual({
      orientation: 1,
      lossless: false,
    });
  });

  it("reads a PNG eXIf chunk", async () => {
    await expect(readImageOrientation(readerOf(png(tiff(8))), "image/png")).resolves.toEqual({
      orientation: 8,
      lossless: false,
    });
  });

  it("answers 1 for a PNG with no eXIf chunk", async () => {
    await expect(readImageOrientation(readerOf(png(null)), "image/png")).resolves.toEqual({
      orientation: 1,
      lossless: false,
    });
  });

  it("finds a WebP EXIF chunk that sits past 64 KiB of image data", async () => {
    const bytes = webp({ exif: tiff(6), exifFlag: true, imageBytes: 200_000, lossless: false });
    const reader = readerOf(bytes);
    await expect(readImageOrientation(reader, "image/webp")).resolves.toEqual({
      orientation: 6,
      lossless: false,
    });
    // It skips the image data by its length instead of reading it.
    const bytesRead = reader.calls.reduce((n, [, length]) => n + length, 0);
    expect(bytesRead).toBeLessThan(70_000);
  });

  it("reads a WebP EXIF chunk that carries the Exif prefix", async () => {
    const bytes = webp({ exif: tiff(3), exifFlag: true, imageBytes: 300, lossless: false, exifPrefix: true });
    await expect(readImageOrientation(readerOf(bytes), "image/webp")).resolves.toEqual({
      orientation: 3,
      lossless: false,
    });
  });

  it("tells a lossless WebP by its VP8L chunk", async () => {
    const bytes = webp({ exif: tiff(6), exifFlag: true, imageBytes: 300, lossless: true });
    await expect(readImageOrientation(readerOf(bytes), "image/webp")).resolves.toEqual({
      orientation: 6,
      lossless: true,
    });
  });

  it("answers 1 for a WebP whose VP8X says there is no EXIF", async () => {
    const bytes = webp({ exif: null, exifFlag: false, imageBytes: 300, lossless: false });
    await expect(readImageOrientation(readerOf(bytes), "image/webp")).resolves.toEqual({
      orientation: 1,
      lossless: false,
    });
  });

  it("answers 1 for a simple WebP and still tells lossless", async () => {
    await expect(readImageOrientation(readerOf(simpleWebp(true)), "image/webp")).resolves.toEqual({
      orientation: 1,
      lossless: true,
    });
  });

  it("answers 1 for a type it does not read", async () => {
    await expect(readImageOrientation(readerOf(new Uint8Array(10)), "image/gif")).resolves.toEqual({
      orientation: 1,
      lossless: false,
    });
  });

  it("reports a failed read apart from a missing tag", async () => {
    await expect(readImageOrientation(failing, "image/jpeg")).resolves.toBe("unreadable");
  });
});
