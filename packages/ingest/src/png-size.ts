// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How big the frame the container cut is (#209 + #210).
 *
 * A cover is its own asset row, and that row states pixel dimensions. They are
 * not the video's: the frame is capped on the way out of ffmpeg, so anything
 * shot wider comes back smaller. Asking the bytes is what keeps the row true
 * about itself whatever the cap does.
 */

/** `\x89PNG\r\n\x1a\n`, which every PNG begins with. */
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** `IHDR`, the first chunk's type, which carries the dimensions. */
const HEADER_CHUNK = [0x49, 0x48, 0x44, 0x52];

/** Where the first chunk's type starts: the signature plus its length field. */
const CHUNK_TYPE_AT = 12;

/** Where the dimensions start: right after that type. */
const DIMENSIONS_AT = 16;

/**
 * Whether `bytes` carries `expected` at `offset`.
 * @param bytes - What to look in.
 * @param expected - The literal bytes to find.
 * @param offset - Where they should start.
 * @returns Whether every one of them is there.
 */
function matches(
  bytes: Uint8Array,
  expected: number[],
  offset: number,
): boolean {
  return expected.every((byte, i) => bytes[offset + i] === byte);
}

/**
 * The dimensions a PNG declares.
 * @param bytes - The frame, as the container cut it.
 * @returns Its pixel size, or null when the bytes do not declare one.
 * @throws {never} Anything unreadable answers as nothing.
 */
export function pngSize(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  if (bytes.length < DIMENSIONS_AT + 8) return null;
  if (!matches(bytes, SIGNATURE, 0)) return null;
  if (!matches(bytes, HEADER_CHUNK, CHUNK_TYPE_AT)) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(DIMENSIONS_AT);
  const height = view.getUint32(DIMENSIONS_AT + 4);
  // A PNG may not declare a zero dimension, so bytes that do are not one.
  if (width === 0 || height === 0) return null;
  return { width, height };
}
