// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The EXIF orientation a stored picture is to be shown at (inner#1367).
 *
 * Read with ranged reads, never the whole object: the tag sits in the first
 * segments of a JPEG or PNG, and in a WebP it sits after the image data, so a
 * WebP is walked chunk header by chunk header. A read R2 refused is answered
 * apart from a picture that carries no tag, because the caller has to log the
 * one and can trust the other.
 */

/** Reads `length` bytes at `offset`; shorter at the end of the object. */
export type RangeReader = (offset: number, length: number) => Promise<Uint8Array>;

/** What a picture's header says about turning it upright. */
export interface ImageOrientation {
  /** EXIF Orientation, 1-8; 1 when the picture carries no tag. */
  orientation: number;
  /** True for a WebP whose image data is VP8L; false for everything else. */
  lossless: boolean;
}

/** How much of a JPEG or PNG is read: an APP1 segment is at most 64 KiB. */
const HEAD_WINDOW = 64 * 1024;

/** The most RIFF chunks a WebP is walked through before giving up. */
const MAX_WEBP_CHUNKS = 64;

const ORIENTATION_TAG = 0x0112;

const UPRIGHT: ImageOrientation = { orientation: 1, lossless: false };

/**
 * Read a stored picture's orientation.
 * @param read - Ranged reads of the stored object.
 * @param contentType - What the stored bytes read as.
 * @returns The orientation, or `unreadable` when a read failed.
 */
export async function readImageOrientation(
  read: RangeReader,
  contentType: string,
): Promise<ImageOrientation | "unreadable"> {
  try {
    if (contentType === "image/jpeg") return { orientation: jpegOrientation(await read(0, HEAD_WINDOW)), lossless: false };
    if (contentType === "image/png") return { orientation: pngOrientation(await read(0, HEAD_WINDOW)), lossless: false };
    if (contentType === "image/webp") return await webpOrientation(read);
    return UPRIGHT;
  } catch {
    return "unreadable";
  }
}

/**
 * The orientation in a JPEG's APP1 Exif segment.
 * @param bytes - The start of the file.
 * @returns 1-8.
 */
function jpegOrientation(bytes: Uint8Array): number {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return 1;
    const marker = bytes[at + 1] ?? 0;
    // Start of scan or end of image: no metadata segment follows.
    if (marker === 0xda || marker === 0xd9) return 1;
    const length = ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0);
    if (length < 2) return 1;
    if (marker === 0xe1 && startsWith(bytes, at + 4, "Exif\0\0")) {
      return tiffOrientation(bytes.subarray(at + 10, at + 2 + length));
    }
    at += 2 + length;
  }
  return 1;
}

/**
 * The orientation in a PNG's eXIf chunk, which the spec puts before IDAT.
 * @param bytes - The start of the file.
 * @returns 1-8.
 */
function pngOrientation(bytes: Uint8Array): number {
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = readU32(bytes, at, false);
    const type = ascii(bytes, at + 4, 4);
    if (type === "IDAT" || type === "IEND") return 1;
    if (type === "eXIf") return tiffOrientation(bytes.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  return 1;
}

/**
 * Walk a WebP's RIFF chunks for the image type and the EXIF chunk.
 * @param read - Ranged reads of the stored object.
 * @returns The orientation and whether the image data is lossless.
 */
async function webpOrientation(read: RangeReader): Promise<ImageOrientation> {
  const header = await read(0, 12);
  if (ascii(header, 0, 4) !== "RIFF" || ascii(header, 8, 4) !== "WEBP") return UPRIGHT;
  const end = 8 + readU32(header, 4, true);
  let lossless = false;
  let imageSeen = false;
  let exifExpected = false;
  let at = 12;
  for (let i = 0; i < MAX_WEBP_CHUNKS && at + 8 <= end; i++) {
    const chunk = await read(at, 18);
    if (chunk.length < 8) break;
    const type = ascii(chunk, 0, 4);
    const size = readU32(chunk, 4, true);
    if (type === "VP8X") exifExpected = ((chunk[8] ?? 0) & 0x08) !== 0;
    if (type === "VP8L" || type === "VP8 ") {
      lossless = type === "VP8L";
      imageSeen = true;
      if (!exifExpected) break;
    }
    if (type === "EXIF") {
      const payload = await read(at + 8, size);
      const tiff = startsWith(payload, 0, "Exif\0\0") ? payload.subarray(6) : payload;
      return { orientation: tiffOrientation(tiff), lossless };
    }
    at += 8 + size + (size % 2);
  }
  return { orientation: 1, lossless: imageSeen && lossless };
}

/**
 * The Orientation entry of a TIFF block's first IFD.
 * @param tiff - The block, starting at its byte-order mark.
 * @returns 1-8; 1 when the block is short, malformed or holds no valid entry.
 */
function tiffOrientation(tiff: Uint8Array): number {
  if (tiff.length < 8) return 1;
  const order = ascii(tiff, 0, 2);
  if (order !== "II" && order !== "MM") return 1;
  const little = order === "II";
  if (readU16(tiff, 2, little) !== 42) return 1;
  const ifd = readU32(tiff, 4, little);
  if (ifd + 2 > tiff.length) return 1;
  const count = readU16(tiff, ifd, little);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) return 1;
    if (readU16(tiff, entry, little) !== ORIENTATION_TAG) continue;
    const value = readU16(tiff, entry + 8, little);
    return value >= 1 && value <= 8 ? value : 1;
  }
  return 1;
}

/**
 * Whether `bytes` holds `text` at `at`.
 * @param bytes - The bytes.
 * @param at - Where to look.
 * @param text - ASCII text.
 * @returns True when every character matches.
 */
function startsWith(bytes: Uint8Array, at: number, text: string): boolean {
  return ascii(bytes, at, text.length) === text;
}

/**
 * ASCII text out of bytes.
 * @param bytes - The bytes.
 * @param at - Where the text starts.
 * @param length - How many characters.
 * @returns The text, shorter when the bytes end first.
 */
function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length));
}

/**
 * An unsigned 16-bit integer.
 * @param bytes - The bytes.
 * @param at - Its offset.
 * @param little - Little-endian when true.
 * @returns The value, 0 past the end.
 */
function readU16(bytes: Uint8Array, at: number, little: boolean): number {
  const a = bytes[at] ?? 0;
  const b = bytes[at + 1] ?? 0;
  return little ? a | (b << 8) : (a << 8) | b;
}

/**
 * An unsigned 32-bit integer.
 * @param bytes - The bytes.
 * @param at - Its offset.
 * @param little - Little-endian when true.
 * @returns The value, 0 past the end.
 */
function readU32(bytes: Uint8Array, at: number, little: boolean): number {
  const hi = readU16(bytes, little ? at + 2 : at, little);
  const lo = readU16(bytes, little ? at : at + 2, little);
  return hi * 0x10000 + lo;
}
