// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Rasterise a solid-colour blank PNG entirely in the browser (#1623, D1), then
 * wrap it as a `File` so the reset-empty flow can hand it to the SAME upload
 * pipeline a dropped image uses (`fillUpload` → presign → node content). Mirrors
 * the focus-crop export technique (`focus/crop-export.ts`), swapping `drawImage`
 * for a `fillRect`. Needs a real `<canvas>`, so it is covered by browser smoke,
 * not jsdom unit tests (jsdom implements no 2d context / `toBlob`).
 */

/**
 * Generate a `width`×`height` PNG filled with `color`.
 * @param width - Image width in pixels (caller clamps to a valid range).
 * @param height - Image height in pixels (caller clamps to a valid range).
 * @param color - CSS colour string used as the solid fill (e.g. `white` or a hex string).
 * @returns A PNG `File` named `blank-<w>x<h>.png`.
 * @throws {Error} When no 2d context is available or rasterisation yields no blob.
 */
export async function generateBlankPng(
  width: number,
  height: number,
  color: string,
): Promise<File> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/png'),
  );
  if (!blob) throw new Error('canvas export produced no blob');
  return new File([blob], `blank-${width}x${height}.png`, { type: 'image/png' });
}
