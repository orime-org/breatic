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
 * format REQUIRES to be the first chunk — bytes 16..23, immediately after the
 * 8-byte signature and the chunk's own length and type. Nothing is
 * decompressed, and a hostile file gets exactly 24 bytes of attention.
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

/** Signature (8) + chunk length (4) + chunk type (4) + width (4) + height (4). */
const HEADER_BYTES = 24;

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
  // IHDR is mandated to come first, so its type tag sits at a fixed offset.
  // Scanning for it instead would mean trusting lengths from the same file.
  if (bytes.subarray(12, 16).toString("ascii") !== "IHDR") return null;

  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0) return null;
  return { width, height };
}
