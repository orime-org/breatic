// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** One COCO compressed RLE mask, its size ordered height then width. */
export interface CocoRleMask {
  size: readonly [number, number];
  counts: string;
}

/** A mask's pixel size. */
export interface CocoMaskSize { width: number; height: number }

/**
 * Decodes COCO's signed variable-length counts into row-major VOID mask bytes.
 * @param rle - Column-major COCO mask, with dimensions ordered height then width.
 * @param expected - Dimensions of the normalized source frame bound to this mask.
 * @returns Gray8 bytes with removed foreground zero and retained background 255.
 * @throws {RangeError} When dimensions, encoded counts or total coverage are invalid.
 */
export function decodeCocoRleMask(rle: CocoRleMask, expected: CocoMaskSize): Uint8Array {
  const [height, width] = rle.size;
  if (![height, width, expected.height, expected.width].every((value) => Number.isSafeInteger(value) && value > 0)
    || height !== expected.height || width !== expected.width || !Number.isSafeInteger(height * width)) {
    throw new RangeError("Mask dimensions do not match the normalized source frame");
  }
  const area = height * width;
  const runs: number[] = [];
  let offset = 0;
  let covered = 0;
  while (offset < rle.counts.length) {
    let value = 0;
    let place = 1;
    let more: boolean;
    do {
      if (offset >= rle.counts.length) throw new RangeError("Truncated COCO count");
      const code = rle.counts.charCodeAt(offset++) - 48;
      if (code < 0 || code > 63) throw new RangeError("Invalid COCO count character");
      value += (code & 31) * place;
      more = (code & 32) !== 0;
      place *= 32;
      if (!Number.isSafeInteger(value) || !Number.isSafeInteger(place)) throw new RangeError("COCO count exceeds safe integer precision");
      if (!more && (code & 16) !== 0) value -= place;
    } while (more);
    if (runs.length > 2) value += runs[runs.length - 2]!;
    if (!Number.isSafeInteger(value) || value < 0 || value > area - covered) throw new RangeError("Invalid COCO run coverage");
    covered += value;
    runs.push(value);
  }
  if (covered !== area) throw new RangeError("COCO runs do not cover the source frame");
  const bytes = new Uint8Array(area);
  let columnOffset = 0;
  for (let runIndex = 0; runIndex < runs.length; runIndex++) {
    const end = columnOffset + runs[runIndex]!;
    const gray = runIndex % 2 === 0 ? 255 : 0;
    while (columnOffset < end) {
      const x = Math.floor(columnOffset / height);
      const y = columnOffset % height;
      bytes[y * width + x] = gray;
      columnOffset++;
    }
  }
  return bytes;
}
