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

function png(exif: Uint8Array | null, animated = false): Uint8Array {
  return concat(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", new Uint8Array(13)),
    animated ? pngChunk("acTL", new Uint8Array(8)) : new Uint8Array(0),
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
  animated?: boolean;
}): Uint8Array {
  const vp8x = new Uint8Array(10);
  vp8x[0] = (options.exifFlag ? 0x08 : 0) | (options.animated === true ? 0x02 : 0);
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

/**
 * Ranged reads of `bytes` the way R2 answers them: a range that starts at or
 * past the end, or has no length, is refused; one that runs past the end
 * comes back short.
 */
function readerOf(bytes: Uint8Array): CountingReader {
  const calls: Array<[number, number]> = [];
  const read = async (offset: number, length: number): Promise<Uint8Array> => {
    calls.push([offset, length]);
    if (offset >= bytes.length || length <= 0) throw new Error("The requested range is not satisfiable");
    return bytes.slice(offset, offset + length);
  };
  return Object.assign(read, { calls });
}

/** The orientation of `bytes`, read through {@link readerOf}. */
function orientationOf(bytes: Uint8Array, type: string, reader = readerOf(bytes)): ReturnType<typeof readImageOrientation> {
  return readImageOrientation(reader, type, bytes.length);
}

const failing: RangeReader = async () => {
  throw new Error("R2 range read failed");
};

describe("readImageOrientation", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])("reads orientation %i from a big-endian JPEG", async (value) => {
    await expect(orientationOf(jpeg(tiff(value)), "image/jpeg")).resolves.toEqual({
      orientation: value,
      lossless: false,
      animated: false,
      outOfBounds: false,
    });
  });

  it("reads a little-endian JPEG", async () => {
    await expect(orientationOf(jpeg(tiff(6, true)), "image/jpeg")).resolves.toEqual({
      orientation: 6,
      lossless: false,
      animated: false,
      outOfBounds: false,
    });
  });

  it("answers 1 for a JPEG with no EXIF", async () => {
    await expect(orientationOf(jpeg(null), "image/jpeg")).resolves.toEqual({
      orientation: 1,
      lossless: false,
      animated: false,
      outOfBounds: false,
    });
  });

  it("answers 1 for a JPEG whose EXIF is cut short, and says its segment ran past the end", async () => {
    const cut = jpeg(tiff(6)).slice(0, 30);
    await expect(orientationOf(cut, "image/jpeg")).resolves.toEqual({
      orientation: 1,
      lossless: false,
      animated: false,
      outOfBounds: true,
    });
  });

  it("answers 1 for an orientation value outside 1-8", async () => {
    await expect(orientationOf(jpeg(tiff(9)), "image/jpeg")).resolves.toEqual({
      orientation: 1,
      lossless: false,
      animated: false,
      outOfBounds: false,
    });
  });

  it("reads a PNG eXIf chunk", async () => {
    await expect(orientationOf(png(tiff(8)), "image/png")).resolves.toEqual({
      orientation: 8,
      lossless: false,
      animated: false,
      outOfBounds: false,
    });
  });

  it("answers 1 for a PNG with no eXIf chunk", async () => {
    await expect(orientationOf(png(null), "image/png")).resolves.toEqual({
      orientation: 1,
      lossless: false,
      animated: false,
      outOfBounds: false,
    });
  });

  it("finds a WebP EXIF chunk that sits past 64 KiB of image data", async () => {
    const bytes = webp({ exif: tiff(6), exifFlag: true, imageBytes: 200_000, lossless: false });
    const reader = readerOf(bytes);
    await expect(orientationOf(bytes, "image/webp", reader)).resolves.toEqual({
      orientation: 6,
      lossless: false,
      animated: false,
      outOfBounds: false,
    });
    // It skips the image data by its length instead of reading it.
    const bytesRead = reader.calls.reduce((n, [, length]) => n + length, 0);
    expect(bytesRead).toBeLessThan(70_000);
  });

  it("reads a WebP EXIF chunk that carries the Exif prefix", async () => {
    const bytes = webp({ exif: tiff(3), exifFlag: true, imageBytes: 300, lossless: false, exifPrefix: true });
    await expect(orientationOf(bytes, "image/webp")).resolves.toEqual({
      orientation: 3,
      lossless: false,
      animated: false,
      outOfBounds: false,
    });
  });

  it("tells a lossless WebP by its VP8L chunk", async () => {
    const bytes = webp({ exif: tiff(6), exifFlag: true, imageBytes: 300, lossless: true });
    await expect(orientationOf(bytes, "image/webp")).resolves.toEqual({
      orientation: 6,
      lossless: true,
      animated: false,
      outOfBounds: false,
    });
  });

  it("answers 1 for a WebP whose VP8X says there is no EXIF", async () => {
    const bytes = webp({ exif: null, exifFlag: false, imageBytes: 300, lossless: false });
    await expect(orientationOf(bytes, "image/webp")).resolves.toEqual({
      orientation: 1,
      lossless: false,
      animated: false,
      outOfBounds: false,
    });
  });

  it("answers 1 for a simple WebP and still tells lossless", async () => {
    await expect(orientationOf(simpleWebp(true), "image/webp")).resolves.toEqual({
      orientation: 1,
      lossless: true,
      animated: false,
      outOfBounds: false,
    });
  });

  // An animated picture is kept as it is: vips autorot writes out only its
  // first frame (inner#1367 §4.2).
  it("tells an animated WebP by its VP8X animation flag", async () => {
    const bytes = webp({ exif: tiff(6), exifFlag: true, imageBytes: 300, lossless: false, animated: true });
    await expect(orientationOf(bytes, "image/webp")).resolves.toEqual({
      orientation: 6,
      lossless: false,
      animated: true,
      outOfBounds: false,
    });
  });

  it("tells an animated PNG by an acTL chunk ahead of its image data", async () => {
    await expect(orientationOf(png(tiff(6), true), "image/png")).resolves.toEqual({
      orientation: 6,
      lossless: false,
      animated: true,
      outOfBounds: false,
    });
  });

  it("answers 1 for a type it does not read", async () => {
    await expect(orientationOf(new Uint8Array(10), "image/gif")).resolves.toEqual({
      orientation: 1,
      lossless: false,
      animated: false,
      outOfBounds: false,
    });
  });

  // inner#1367 §4.3: a cut-short tag is no tag. Every read stays inside the
  // object, so R2 never refuses a range past its end.
  it("answers 1 for a WebP cut off before the chunk its header promises", async () => {
    const whole = webp({ exif: tiff(6), exifFlag: true, imageBytes: 300, lossless: false });
    const cut = whole.slice(0, 30 + 8 + 300);
    await expect(orientationOf(cut, "image/webp")).resolves.toEqual({
      orientation: 1,
      lossless: false,
      animated: false,
      outOfBounds: false,
    });
  });

  it("answers 1 for a WebP whose EXIF chunk is empty", async () => {
    const bytes = webp({ exif: new Uint8Array(0), exifFlag: true, imageBytes: 300, lossless: false });
    await expect(orientationOf(bytes, "image/webp")).resolves.toEqual({
      orientation: 1,
      lossless: false,
      animated: false,
      outOfBounds: false,
    });
  });

  it("reads at most 64 KiB of an EXIF chunk that claims far more than the object holds, and says so", async () => {
    const real = webp({ exif: tiff(6), exifFlag: true, imageBytes: 300, lossless: false });
    // The EXIF chunk's size field sits 4 bytes after its type.
    const exifAt = real.length - 8 - tiff(6).length;
    const claimed = real.slice();
    claimed.set(u32le(200 * 1024 * 1024), exifAt + 4);
    const reader = readerOf(claimed);
    await expect(orientationOf(claimed, "image/webp", reader)).resolves.toEqual({
      orientation: 6,
      lossless: false,
      animated: false,
      outOfBounds: true,
    });
    expect(Math.max(...reader.calls.map(([, length]) => length))).toBeLessThanOrEqual(64 * 1024);
  });

  it("reads the start of an EXIF chunk larger than 64 KiB, and says it was larger", async () => {
    const big = concat(tiff(6), new Uint8Array(100_000));
    const bytes = webp({ exif: big, exifFlag: true, imageBytes: 300, lossless: false });
    const reader = readerOf(bytes);
    await expect(orientationOf(bytes, "image/webp", reader)).resolves.toEqual({
      orientation: 6,
      lossless: false,
      animated: false,
      outOfBounds: true,
    });
    expect(Math.max(...reader.calls.map(([, length]) => length))).toBeLessThanOrEqual(64 * 1024);
  });

  it("finds a PNG eXIf chunk that sits past 64 KiB of other chunks", async () => {
    const bytes = concat(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", new Uint8Array(13)),
      pngChunk("iTXt", new Uint8Array(100_000)),
      pngChunk("eXIf", tiff(6)),
      pngChunk("IDAT", new Uint8Array(500)),
      pngChunk("IEND", new Uint8Array(0)),
    );
    await expect(orientationOf(bytes, "image/png")).resolves.toEqual({
      orientation: 6,
      lossless: false,
      animated: false,
      outOfBounds: false,
    });
  });

  it("finds a JPEG APP1 that sits past 64 KiB of other segments", async () => {
    const app2 = concat(new Uint8Array([0xff, 0xe2]), u16be(60_000), new Uint8Array(59_998));
    const app1 = concat(new Uint8Array([0xff, 0xe1]), u16be(2 + 6 + tiff(6).length), ascii("Exif\0\0"), tiff(6));
    const sos = concat(new Uint8Array([0xff, 0xda]), u16be(8), new Uint8Array(6), new Uint8Array(1000));
    const bytes = concat(new Uint8Array([0xff, 0xd8]), app2, app2, app1, sos, new Uint8Array([0xff, 0xd9]));
    await expect(orientationOf(bytes, "image/jpeg")).resolves.toEqual({
      orientation: 6,
      lossless: false,
      animated: false,
      outOfBounds: false,
    });
  });

  it("stops after 64 reads past its first window, however many segments follow", async () => {
    const filler = concat(new Uint8Array([0xff, 0xe2]), u16be(65_000), new Uint8Array(64_998));
    const tiny = concat(new Uint8Array([0xff, 0xe3]), u16be(2));
    const app1 = concat(new Uint8Array([0xff, 0xe1]), u16be(2 + 6 + tiff(6).length), ascii("Exif\0\0"), tiff(6));
    const tinies = concat(...Array.from({ length: 200 }, () => tiny));
    const bytes = concat(new Uint8Array([0xff, 0xd8]), filler, tinies, app1, new Uint8Array([0xff, 0xd9]));
    const reader = readerOf(bytes);
    await expect(orientationOf(bytes, "image/jpeg", reader)).resolves.toMatchObject({ orientation: 1 });
    expect(reader.calls.length).toBe(1 + 64);
  });

  it("answers 1 for a PNG that ends right after a chunk, before its image data", async () => {
    // The next header would start exactly at the end, where R2 refuses a range.
    const bytes = concat(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", new Uint8Array(13)),
    );
    await expect(orientationOf(bytes, "image/png")).resolves.toEqual({
      orientation: 1,
      lossless: false,
      animated: false,
      outOfBounds: false,
    });
  });

  it("reads a picture smaller than its first window without a range past the end", async () => {
    await expect(orientationOf(png(tiff(6)), "image/png")).resolves.toMatchObject({ orientation: 6 });
  });

  it("rejects with the read's own error when a read fails", async () => {
    await expect(readImageOrientation(failing, "image/jpeg", 2000)).rejects.toThrow("R2 range read failed");
  });
});
