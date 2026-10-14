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

/** The sides the filters can draw at: the shared backend's square, and what the graphics take. */
export interface BackendSides {
  shared: number;
  max: number;
}

/**
 * Which backend an export of a picture this long goes through. Fabric's shared
 * WebGL backend draws its last pass on a square of `config.textureSize` and
 * cuts off whatever is past it, so a longer picture gets a backend of its own
 * as long as the picture, up to the graphics' texture limit.
 * @param longSide - The picture's long side in pixels.
 * @param sides - The shared backend's square and the graphics' limit.
 * @returns `'shared'`, the side of a backend of its own, or `'tooLarge'`.
 */
export function exportBackendSide(longSide: number, sides: BackendSides): 'shared' | number | 'tooLarge' {
  if (longSide > sides.max) return 'tooLarge';
  return longSide > sides.shared ? longSide : 'shared';
}

/**
 * The shared backend's square and the graphics' texture limit; both are
 * unbounded when Fabric filters without WebGL.
 * @returns The sides.
 */
async function backendSides(): Promise<BackendSides> {
  const [fabric] = await loadRuntime();
  const backend = fabric.getFilterBackend();
  if (!(backend instanceof fabric.WebGLFilterBackend)) return { shared: Infinity, max: Infinity };
  const gl = document.createElement('canvas').getContext('webgl');
  if (gl === null) return { shared: backend.tileSize, max: backend.tileSize };
  const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return { shared: backend.tileSize, max };
}

/** A picture's preview-sized copies, one per picture, kept for its last size. */
const previewCopies = new WeakMap<CropSourceEl, { width: number; height: number; canvas: HTMLCanvasElement }>();

/**
 * What the filters draw from at a given size: the picture itself when it is no
 * larger, otherwise a copy scaled to that size with smoothing. The filters
 * sample by nearest neighbour, so a larger source drawn straight into the size
 * keeps one pixel in every few and the preview stops matching the export. A
 * picture's copy is kept for its size; a video's frame moves, so its copy is
 * drawn each time.
 * @param el - The picture.
 * @param size - The size the filters draw at.
 * @param size.width - Its width.
 * @param size.height - Its height.
 * @returns The source to filter.
 * @throws {never} Never.
 */
export function previewSourceOf(
  el: CropSourceEl,
  size: { width: number; height: number },
): CropSourceEl | HTMLCanvasElement {
  const own = intrinsicSize(el);
  if (own.width <= size.width && own.height <= size.height) return el;
  const kept = el instanceof HTMLVideoElement ? undefined : previewCopies.get(el);
  if (kept !== undefined && kept.width === size.width && kept.height === size.height) return kept.canvas;
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (context === null) return el;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(el, 0, 0, size.width, size.height);
  if (!(el instanceof HTMLVideoElement)) previewCopies.set(el, { ...size, canvas });
  return canvas;
}

/**
 * Draw a picture through the adjust onto a canvas sized to the picture. The
 * picture must be CORS-loaded: WebGL refuses a cross-origin image outright.
 * @param el - The picture.
 * @param asked - The size to draw it at, held to what the backend can draw.
 * @param asked.width - Its width.
 * @param asked.height - Its height.
 * @param value - The sliders.
 * @param target - The canvas, resized to the size drawn.
 * @param backend - The filter backend to draw through; Fabric's shared one by default.
 */
export async function drawAdjusted(
  el: CropSourceEl,
  asked: { width: number; height: number },
  value: AdjustValue,
  target: HTMLCanvasElement,
  backend?: ReturnType<typeof import('fabric')['getFilterBackend']>,
): Promise<void> {
  const [fabric, { adjustFilters, ADJUST_GRAIN_SEED }] = await loadRuntime();
  const through = backend ?? fabric.getFilterBackend();
  // A WebGL backend draws its last pass on a square of its tile size and cuts
  // off what is past it.
  const size = fitWithin(asked, 'tileSize' in through ? through.tileSize : Infinity);
  target.width = size.width;
  target.height = size.height;
  const chain = adjustFilters(value, ADJUST_GRAIN_SEED, intrinsicSize(el));
  const source = previewSourceOf(el, size);
  if (chain.length === 0) {
    target.getContext('2d')?.drawImage(source, 0, 0, size.width, size.height);
    return;
  }
  through.applyFilters(chain, source, size.width, size.height, target);
}

/**
 * A size scaled down, keeping its shape, so neither side passes a length.
 * @param size - The size.
 * @param size.width - Its width.
 * @param size.height - Its height.
 * @param side - The longest a side may be.
 * @returns The size, unchanged when it fits.
 * @throws {never} Never.
 */
function fitWithin(size: { width: number; height: number }, side: number): { width: number; height: number } {
  const scale = side / Math.max(size.width, size.height);
  if (scale >= 1) return size;
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
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
  const side = exportBackendSide(Math.max(size.width, size.height), await backendSides());
  if (side === 'tooLarge') throw new ImageTooLargeError();
  const [fabric] = await loadRuntime();
  // A backend of its own for a picture past the shared square, released at once.
  const own = side === 'shared' ? undefined : new fabric.WebGLFilterBackend({ tileSize: side });
  try {
    const canvas = document.createElement('canvas');
    await drawAdjusted(el, size, value, canvas, own);
    return await pngOf(canvas);
  } finally {
    own?.dispose();
  }
}
