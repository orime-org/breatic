// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { CapturedPixels } from '@web/spaces/three-d/viewport/scene-viewport-props';

/**
 * WebGL reads rows bottom-up; images are stored top-down.
 * @param pixels - RGBA bytes as read back.
 * @param width - Pixels per row.
 * @param height - Rows.
 * @returns A new array with the rows in image order.
 */
export function flipRows(pixels: Uint8Array, width: number, height: number): Uint8ClampedArray {
  const row = width * 4;
  const out = new Uint8ClampedArray(pixels.length);
  for (let y = 0; y < height; y += 1) out.set(pixels.subarray(y * row, (y + 1) * row), (height - 1 - y) * row);
  return out;
}

/**
 * Encode a capture as a PNG.
 * @param capture - The read-back pixels and their size.
 * @returns The PNG.
 * @throws {Error} When the browser has no 2D context for an offscreen canvas.
 */
export async function encodeCapturePng(capture: CapturedPixels): Promise<Blob> {
  const canvas = new OffscreenCanvas(capture.width, capture.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2d context for the capture');
  context.putImageData(new ImageData(flipRows(capture.pixels, capture.width, capture.height), capture.width, capture.height), 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}
