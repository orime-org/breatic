// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The EXIF orientation a stored picture is to be shown at (inner#1367).
 *
 * One window from the start of the object is read; segments and chunks past
 * it are reached by ranged reads of their headers, so image data is skipped by
 * its length and never read. Every read is held inside the object's own size:
 * R2 refuses a range that starts at its end, and a file that promises more
 * than it holds is a cut-short file, read as carrying no tag. A read R2
 * refuses for any other reason rejects, for the caller to log.
 */

/** Reads `length` bytes at `offset`; shorter at the end of the object. */
export type RangeReader = (offset: number, length: number) => Promise<Uint8Array>;

/** What a picture's header says about turning it upright. */
export interface ImageOrientation {
  /** EXIF Orientation, 1-8; 1 when the picture carries no tag. */
  orientation: number;
  /** True for a WebP whose image data is VP8L; false for everything else. */
  lossless: boolean;
  /**
   * True for an animated WebP (the VP8X animation flag) or PNG (an `acTL`
   * chunk ahead of IDAT). One is kept as it is: vips autorot writes out only
   * its first frame.
   */
  animated: boolean;
  /**
   * True when a metadata block claimed more than {@link MAX_METADATA_BYTES} or
   * more than the object holds. Cameras and phones write a few dozen KiB; a
   * block past either bound was made that way on purpose.
   */
  outOfBounds: boolean;
}

/** The first read: the whole head of most pictures, metadata included. */
const HEAD_WINDOW = 64 * 1024;

/**
 * The most of one metadata block that is read. IFD0, which holds the
 * Orientation entry, is the first thing in the block.
 */
const MAX_METADATA_BYTES = 64 * 1024;

/** The most ranged reads past the head window before giving up. */
const MAX_READS_PAST_HEAD = 64;

const ORIENTATION_TAG = 0x0112;

const UPRIGHT: ImageOrientation = { orientation: 1, lossless: false, animated: false, outOfBounds: false };

/** Bytes of one stored object, held inside its size. */
interface ByteSource {
  size: number;
  /**
   * Bytes at `offset`, at most `length` of them and never past the end. Empty
   * at or past the end, and once the reads past the head are spent.
   */
  at: (offset: number, length: number) => Promise<Uint8Array>;
}

/**
 * A source over a stored object whose head is already read.
 * @param read - Ranged reads of the object.
 * @param size - The object's size in bytes.
 * @param head - The object's first bytes.
 * @returns The source.
 */
function sourceOf(read: RangeReader, size: number, head: Uint8Array): ByteSource {
  let readsLeft = MAX_READS_PAST_HEAD;
  return {
    size,
    at: async (offset, length) => {
      const wanted = Math.min(length, size - offset);
      if (offset < 0 || wanted <= 0) return new Uint8Array(0);
      if (offset + wanted <= head.length) return head.subarray(offset, offset + wanted);
      if (readsLeft === 0) return new Uint8Array(0);
      readsLeft -= 1;
      return read(offset, wanted);
    },
  };
}

/**
 * Read a stored picture's orientation.
 * @param read - Ranged reads of the stored object.
 * @param contentType - What the stored bytes read as.
 * @param size - The object's size in bytes.
 * @returns The orientation.
 * @throws {Error} When R2 refuses a read.
 */
export async function readImageOrientation(
  read: RangeReader,
  contentType: string,
  size: number,
): Promise<ImageOrientation> {
  const walk = WALKERS[contentType];
  if (walk === undefined || size === 0) return UPRIGHT;
  const head = await read(0, Math.min(HEAD_WINDOW, size));
  return walk(sourceOf(read, size, head));
}

/** A metadata block found in a picture. */
interface Metadata {
  /** Its first bytes, at most {@link MAX_METADATA_BYTES}. */
  bytes: Uint8Array;
  outOfBounds: boolean;
}

/**
 * Read a metadata block of `length` bytes at `offset`.
 * @param source - The object.
 * @param offset - Where the block's data starts.
 * @param length - How long the file says it is.
 * @returns Its first bytes, and whether its length went past either bound.
 */
async function metadataAt(source: ByteSource, offset: number, length: number): Promise<Metadata> {
  return {
    bytes: await source.at(offset, Math.min(length, MAX_METADATA_BYTES)),
    outOfBounds: length > MAX_METADATA_BYTES || offset + length > source.size,
  };
}

/**
 * The orientation in a JPEG's APP1 Exif segment, walked segment by segment up
 * to the start of the scan.
 * @param source - The object.
 * @returns The orientation.
 */
async function jpegOrientation(source: ByteSource): Promise<ImageOrientation> {
  const soi = await source.at(0, 2);
  if (soi[0] !== 0xff || soi[1] !== 0xd8) return UPRIGHT;
  let at = 2;
  for (;;) {
    const header = await source.at(at, 4);
    if (header.length < 4 || header[0] !== 0xff) return UPRIGHT;
    const marker = header[1] ?? 0;
    // Start of scan or end of image: no metadata segment follows.
    if (marker === 0xda || marker === 0xd9) return UPRIGHT;
    const length = readU16(header, 2, false);
    if (length < 2) return UPRIGHT;
    if (marker === 0xe1) {
      const segment = await metadataAt(source, at + 4, length - 2);
      if (startsWith(segment.bytes, 0, "Exif\0\0")) {
        return {
          ...UPRIGHT,
          orientation: tiffOrientation(segment.bytes.subarray(6)),
          outOfBounds: segment.outOfBounds,
        };
      }
    }
    at += 2 + length;
  }
}

/**
 * The orientation in a PNG's eXIf chunk, and whether an `acTL` chunk makes it
 * animated; the spec puts both before IDAT.
 * @param source - The object.
 * @returns The orientation and whether it is animated.
 */
async function pngOrientation(source: ByteSource): Promise<ImageOrientation> {
  const found = { ...UPRIGHT };
  let at = 8;
  for (;;) {
    const header = await source.at(at, 8);
    if (header.length < 8) return found;
    const length = readU32(header, 0, false);
    const type = ascii(header, 4, 4);
    if (type === "IDAT" || type === "IEND") return found;
    if (type === "acTL") found.animated = true;
    if (type === "eXIf") {
      const chunk = await metadataAt(source, at + 8, length);
      found.orientation = tiffOrientation(chunk.bytes);
      found.outOfBounds = chunk.outOfBounds;
    }
    at += 12 + length;
  }
}

/**
 * Walk a WebP's RIFF chunks for the image type and the EXIF chunk.
 * @param source - The object.
 * @returns The orientation and whether the image data is lossless.
 */
async function webpOrientation(source: ByteSource): Promise<ImageOrientation> {
  const header = await source.at(0, 12);
  if (ascii(header, 0, 4) !== "RIFF" || ascii(header, 8, 4) !== "WEBP") return UPRIGHT;
  const end = Math.min(8 + readU32(header, 4, true), source.size);
  let lossless = false;
  let imageSeen = false;
  let exifExpected = false;
  let animated = false;
  let at = 12;
  while (at + 8 <= end) {
    const chunk = await source.at(at, 18);
    if (chunk.length < 8) break;
    const type = ascii(chunk, 0, 4);
    const size = readU32(chunk, 4, true);
    if (type === "VP8X") {
      exifExpected = ((chunk[8] ?? 0) & 0x08) !== 0;
      animated = ((chunk[8] ?? 0) & 0x02) !== 0;
    }
    if (type === "VP8L" || type === "VP8 ") {
      lossless = type === "VP8L";
      imageSeen = true;
      if (!exifExpected) break;
    }
    if (type === "EXIF") {
      const exif = await metadataAt(source, at + 8, size);
      const tiff = startsWith(exif.bytes, 0, "Exif\0\0") ? exif.bytes.subarray(6) : exif.bytes;
      return { orientation: tiffOrientation(tiff), lossless, animated, outOfBounds: exif.outOfBounds };
    }
    at += 8 + size + (size % 2);
  }
  return { ...UPRIGHT, lossless: imageSeen && lossless, animated };
}

/** How each type that can carry a tag is walked. */
const WALKERS: Readonly<Record<string, (source: ByteSource) => Promise<ImageOrientation>>> = {
  "image/jpeg": jpegOrientation,
  "image/png": pngOrientation,
  "image/webp": webpOrientation,
};

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
