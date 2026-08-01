// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Reading a PNG's dimensions without decoding it.
 *
 * A byte cap alone does not bound how expensive an image is to look at: PNG is
 * lossless but still compressed, so a few hundred kilobytes of flat colour can
 * expand to tens of thousands of pixels a side. Every viewer's browser would
 * then decode gigabytes for one avatar. That is what checking dimensions
 * catches, and the byte cap cannot.
 *
 * Decoding to find out would reintroduce the same exposure on the server, so
 * this reads the header instead. PNG puts width and height in IHDR, which the
 * format REQUIRES to be the first chunk, immediately after the 8-byte
 * signature and the chunk's own length and type. Nothing here is decompressed:
 * the read stops after IHDR's 13 bytes, whatever the rest of the file holds.
 *
 * It also reads the two fields that change what a decoder must do with a grid
 * of that size — bit depth and interlacing — because dimensions alone do not
 * bound the work. What it cannot bound is a frame COUNT, which is why animated
 * PNG is refused by type before these bytes are ever reached.
 */

/** A PNG's pixel dimensions, as declared by its header. */
export interface PngSize {
  width: number;
  height: number;
}

/** The 8 bytes every PNG (and APNG) starts with. */
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** The IHDR chunk type, as the four bytes it is — not as a decoded string. */
const IHDR_TAG = Buffer.from([0x49, 0x48, 0x44, 0x52]);

/** IHDR's payload length, fixed by the format. */
const IHDR_PAYLOAD_BYTES = 13;

/** Signature (8) + chunk length (4) + chunk type (4) + the whole 13-byte IHDR. */
const HEADER_BYTES = 8 + 4 + 4 + IHDR_PAYLOAD_BYTES;

/** The only bit depth a canvas re-encode produces. */
const EXPECTED_BIT_DEPTH = 8;

/** Adam7 interlacing is value 1; a normal image is 0. */
const NO_INTERLACE = 0;

/**
 * Read a PNG's declared dimensions from its IHDR chunk.
 *
 * Returns null rather than throwing for anything that is not a PNG whose
 * header says something sane — a truncated file, a different format, or a
 * width of zero. The caller turns that into one refusal message; there is
 * nothing an uploader could do differently for each case.
 * @param bytes - The uploaded file's bytes.
 * @returns The declared size, or null when the header is absent or malformed.
 */
export function readPngSize(bytes: Buffer): PngSize | null {
  if (bytes.length < HEADER_BYTES) return null;
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  // The chunk declares its own payload length, and IHDR's is fixed at 13. A
  // file that says otherwise contradicts the format about its own shape, which
  // is reason enough not to believe the numbers inside it.
  if (bytes.readUInt32BE(8) !== IHDR_PAYLOAD_BYTES) return null;
  // IHDR is mandated to come first, so its type tag sits at a fixed offset.
  // Scanning for it instead would mean trusting lengths from the same file.
  //
  // Compared as BYTES. Decoding the tag as "ascii" would mask bit 7, so 0xC9
  // reads back as "I" and fifteen other quadruples pass as IHDR — and bit 5 of
  // each byte is meaningful in this format (ancillary, private, safe-to-copy),
  // so those are different chunks, not spellings of the same one.
  if (!bytes.subarray(12, 16).equals(IHDR_TAG)) return null;

  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0) return null;
  // Dimensions alone do not bound what a decoder has to do with them. Sixteen
  // bits per channel doubles the decoded bytes for the same grid, and Adam7
  // interlacing walks that grid seven times. Neither is something a canvas
  // re-encode can produce, so refusing them turns away nothing we made.
  if (bytes[24] !== EXPECTED_BIT_DEPTH) return null;
  if (bytes[28] !== NO_INTERLACE) return null;
  return { width, height };
}
