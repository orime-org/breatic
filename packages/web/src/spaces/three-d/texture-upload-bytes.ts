// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** An image's declared pixel dimensions. */
export interface ImageSize {
  width: number;
  height: number;
  /** A KTX2 image's declared mip levels, bounded by its full chain; absent for other images. */
  levels?: number;
}

/**
 * Count the bytes a texture uploads with every mip level it carries or generates.
 * Uncompressed images upload RGBA; KTX2 images count the largest desktop Basis transcode (ASTC 4x4, BC7, BC6H, ETC2 RGBA and BC3 all
 * take 16 bytes per 4x4 block), so every device reaches the same verdict. A device with none of those formats decodes to RGBA and
 * uploads more than this estimate.
 * @param size - The texture's declared dimensions and, for KTX2, its declared levels.
 * @param mipmaps - Whether an uncompressed texture generates mipmaps.
 * @returns The byte count.
 * @throws {never} Never.
 */
export function uploadBytes(size: ImageSize, mipmaps: boolean): number {
  let { width, height } = size;
  const levels = size.levels ?? (mipmaps ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1);
  let total = 0;
  for (let level = 0; level < levels; level++) {
    total += size.levels === undefined ? width * height * 4 : Math.ceil(width / 4) * Math.ceil(height / 4) * 16;
    width = Math.max(1, Math.floor(width / 2));
    height = Math.max(1, Math.floor(height / 2));
  }
  return total;
}
