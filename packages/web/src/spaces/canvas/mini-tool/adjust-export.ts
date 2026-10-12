// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Drawing a picture through the adjust's filters (inner#1303 §6.1), for the
 * node's live preview and for the export at the source's own resolution.
 * Fabric and the filters load on first use.
 */

import type { AdjustValue } from '@breatic/shared';

import { pngOf, prepareCropSource, type CropSource } from '@web/spaces/canvas/focus/crop-export';
import { intrinsicSize, type CropSourceEl } from '@web/spaces/canvas/focus/crop-source';

/** The picture's long side is past what this device's graphics can filter in one go. */
export class ImageTooLargeError extends Error {
  /** Name the refusal. */
  constructor() {
    super('the picture is larger than the graphics can filter');
    this.name = 'ImageTooLargeError';
  }
}

/** Fabric and the adjust's filters, loaded once. */
type AdjustRuntime = [typeof import('fabric'), typeof import('@web/spaces/canvas/mini-tool/adjust-filters')];

let runtime: Promise<AdjustRuntime> | undefined;

/**
 * Load Fabric and the filters, once.
 * @returns Both modules.
 */
function loadRuntime(): Promise<AdjustRuntime> {
  runtime ??= Promise.all([import('fabric'), import('@web/spaces/canvas/mini-tool/adjust-filters')]);
  return runtime;
}

/**
 * The longest side the filters can take: the GPU's texture limit when they run
 * on WebGL, none when Fabric fell back to the 2D path.
 * @returns The limit in pixels.
 */
export async function adjustSizeLimit(): Promise<number> {
  const [fabric] = await loadRuntime();
  const backend = fabric.getFilterBackend();
  if (!(backend instanceof fabric.WebGLFilterBackend)) return Infinity;
  const gl = document.createElement('canvas').getContext('webgl');
  if (gl === null) return Infinity;
  const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return max;
}

/**
 * Draw a picture through the adjust onto a canvas sized to the picture.
 * @param el - The picture.
 * @param size - The size to draw it at.
 * @param size.width - Its width.
 * @param size.height - Its height.
 * @param value - The sliders.
 * @param target - The canvas, resized to `size`.
 */
export async function drawAdjusted(
  el: CropSourceEl,
  size: { width: number; height: number },
  value: AdjustValue,
  target: HTMLCanvasElement,
): Promise<void> {
  const [fabric, { adjustFilters, ADJUST_GRAIN_SEED }] = await loadRuntime();
  target.width = size.width;
  target.height = size.height;
  const chain = adjustFilters(value, ADJUST_GRAIN_SEED);
  if (chain.length === 0) {
    target.getContext('2d')?.drawImage(el, 0, 0, size.width, size.height);
    return;
  }
  fabric.getFilterBackend().applyFilters(chain, el, size.width, size.height, target);
}

/**
 * Export the source through the adjust as a PNG at its own resolution.
 * @param source - The picture.
 * @param value - The sliders.
 * @returns The PNG.
 * @throws {ImageTooLargeError} When its long side is past what the graphics can filter.
 * @throws {Error} When the source fails to load CORS-clean, or the canvas cannot export.
 */
export async function exportAdjustedBlob(source: CropSource, value: AdjustValue): Promise<Blob> {
  const el = await prepareCropSource(source);
  const size = intrinsicSize(el);
  if (Math.max(size.width, size.height) > (await adjustSizeLimit())) throw new ImageTooLargeError();
  const canvas = document.createElement('canvas');
  await drawAdjusted(el, size, value, canvas);
  return pngOf(canvas);
}
