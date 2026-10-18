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
 * @throws {Error} When either chunk fails to load.
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

/** A filter backend, WebGL or 2D. */
type FilterBackend = ReturnType<typeof import('fabric')['getFilterBackend']>;

/** Why a backend cannot draw: no WebGL context. */
const NO_CONTEXT = 'The filter backend has no WebGL context to draw with';

/** Why a backend cannot draw: the browser gave it a drawing buffer smaller than its canvas. */
const SHORT_BUFFER = 'The filter backend was given a drawing buffer smaller than its canvas';

/** Fabric's WebGL filter backend. */
type WebGLBackend = Extract<FilterBackend, { tileSize: number }>;

/**
 * A WebGL backend's context while it can draw. Fabric sets `gl` to null on
 * dispose and leaves it so when the browser refuses a new context; a lost one
 * stays lost (Khronos wiki, HandlingContextLost).
 * @param backend - The backend.
 * @returns The context, or null when there is none to draw with.
 * @throws {never} Never.
 */
function liveContext(backend: WebGLBackend): WebGLRenderingContext | null {
  const gl = backend.gl as WebGLRenderingContext | null | undefined;
  return gl == null || gl.isContextLost() ? null : gl;
}

/** Fabric's own calls for its shared filter backend. */
type BackendRegistry = Pick<typeof import('fabric'), 'getFilterBackend' | 'initFilterBackend' | 'setFilterBackend'>;

/**
 * Fabric's shared backend, made again when its WebGL context is gone. Fabric
 * builds it once and hands the same one back (`FilterBackend.ts`
 * `getFilterBackend`), and a lost context stays lost until the page makes a
 * new one (Khronos wiki, HandlingContextLost), so the new one takes its place.
 * @param fabric - Fabric's backend calls.
 * @returns A backend that can draw.
 * @throws {never} Never.
 */
export function liveSharedBackend(fabric: BackendRegistry): FilterBackend {
  const current = fabric.getFilterBackend();
  if (!('tileSize' in current) || liveContext(current) !== null) return current;
  const next = fabric.initFilterBackend();
  fabric.setFilterBackend(next);
  return next;
}

/**
 * The shared backend's square and the graphics' texture limit, read off its
 * own context; both are unbounded when Fabric filters without WebGL. A WebGL
 * backend with no context to draw with (Fabric leaves `gl` unset when the
 * browser refuses one) is a graphics failure, not a size.
 * @param backend - The shared backend.
 * @returns The sides.
 * @throws {Error} When the backend has no WebGL context to draw with.
 */
export function backendSides(backend: FilterBackend): BackendSides {
  if (!('tileSize' in backend)) return { shared: Infinity, max: Infinity };
  const gl = liveContext(backend);
  if (gl === null) throw new Error(NO_CONTEXT);
  return { shared: backend.tileSize, max: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number };
}

/** A picture's preview-sized copies, one per picture, kept for its last size. */
const previewCopies = new WeakMap<CropSourceEl, { width: number; height: number; canvas: HTMLCanvasElement }>();

/**
 * What the filters draw from: the picture itself when the preview draws it at
 * its own size, otherwise a copy scaled by the frame's power of two with
 * smoothing, the picture's last column and row standing in for the pixels
 * past its edge. The filters sample by nearest neighbour, so a larger source
 * drawn straight into the size keeps one pixel in every few and the preview
 * stops matching the export. A picture's copy is kept for its size.
 * @param el - The picture.
 * @param preview - Where the preview draws.
 * @returns The source to filter.
 * @throws {never} Never.
 */
export function previewSourceOf(el: CropSourceEl, preview: PreviewFrame): CropSourceEl | HTMLCanvasElement {
  const { size, frame } = preview;
  const own = intrinsicSize(el);
  if (own.width === size.width && own.height === size.height) return el;
  const kept = previewCopies.get(el);
  if (kept !== undefined && kept.width === size.width && kept.height === size.height) return kept.canvas;
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (context === null) return el;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  const right = (own.width * size.width) / frame.width;
  const bottom = (own.height * size.height) / frame.height;
  const fromX = Math.floor(right);
  const fromY = Math.floor(bottom);
  // The edge strips go down first, from whole pixels, and the picture over
  // them, so a pixel the picture half covers mixes the two by coverage.
  if (fromX < size.width && fromY < size.height) {
    context.drawImage(el, own.width - 1, own.height - 1, 1, 1, fromX, fromY, size.width - fromX, size.height - fromY);
  }
  if (fromX < size.width) context.drawImage(el, own.width - 1, 0, 1, own.height, fromX, 0, size.width - fromX, bottom);
  if (fromY < size.height) context.drawImage(el, 0, own.height - 1, own.width, 1, 0, fromY, right, size.height - fromY);
  context.drawImage(el, 0, 0, right, bottom);
  previewCopies.set(el, { ...size, canvas });
  return canvas;
}

/**
 * Draw a picture through the adjust onto a canvas at the size drawn. The
 * picture must be CORS-loaded: WebGL refuses a cross-origin image outright.
 * @param el - The picture.
 * @param asked - The size it is shown at, or the picture's own for an export; see {@link previewFrame}.
 * @param asked.width - Its width.
 * @param asked.height - Its height.
 * @param value - The sliders.
 * @param target - The canvas, resized to the size drawn.
 * @param backend - The filter backend to draw through; Fabric's shared one by default.
 * @returns Where it drew: the canvas's size and the source pixels it spans.
 * @throws {Error} When Fabric or the filters fail to load, or the backend has no live WebGL context, loses it during the draw, or was given a drawing buffer smaller than its canvas.
 */
export async function drawAdjusted(
  el: CropSourceEl,
  asked: { width: number; height: number },
  value: AdjustValue,
  target: HTMLCanvasElement,
  backend?: FilterBackend,
): Promise<PreviewFrame> {
  const [fabric, { adjustFilters, ADJUST_GRAIN_SEED }] = await loadRuntime();
  const through = backend ?? liveSharedBackend(fabric);
  const drawable = drawableSize(through);
  if (drawable.width === 0) throw new Error(NO_CONTEXT);
  if (bufferShort(through)) throw new Error(SHORT_BUFFER);
  const own = intrinsicSize(el);
  const preview = previewFrame(own, asked, drawable);
  const { size, frame } = preview;
  target.width = size.width;
  target.height = size.height;
  const chain = adjustFilters(value, ADJUST_GRAIN_SEED, own, size, frame);
  const source = previewSourceOf(el, preview);
  if (chain.length === 0) {
    target.getContext('2d')?.drawImage(source, 0, 0, size.width, size.height);
    return preview;
  }
  const state = through.applyFilters(chain, source, size.width, size.height, target);
  if (!('tileSize' in through)) return preview;
  // A context lost during the draw makes Fabric throw on a shader it still has
  // to compile or, with every program cached, copy a blank canvas out without
  // a word; the second is caught here.
  const gl = liveContext(through);
  if (gl === null) throw new Error(NO_CONTEXT);
  // Without a cache key Fabric uploads the source as a texture of its own and
  // hands it back undeleted.
  if (state !== undefined && 'originalTexture' in state) gl.deleteTexture(state.originalTexture);
  return preview;
}

/**
 * Whether a WebGL backend's drawing buffer is smaller than its canvas, as a
 * browser short of memory may grant. Fabric copies the last pass out in
 * canvas coordinates (`WebGLFilterBackend.copyGLTo2D`), so such a backend
 * puts the picture's pixels somewhere else and cannot draw it.
 * @param backend - The backend.
 * @returns True when the buffer is short of the canvas on either side.
 * @throws {never} Never.
 */
function bufferShort(backend: FilterBackend): boolean {
  if (!('tileSize' in backend)) return false;
  const gl = liveContext(backend);
  if (gl === null) return false;
  const canvas = gl.canvas as { width: number; height: number };
  return gl.drawingBufferWidth < canvas.width || gl.drawingBufferHeight < canvas.height;
}

/** A size in pixels. */
interface Size {
  width: number;
  height: number;
}

/**
 * The drawing buffer the browser gave a WebGL backend, which may be smaller
 * than its canvas (headless Chromium's SwiftShader clamps each side to 8192);
 * a buffer smaller than the canvas draws nothing (`bufferShort`). A lost
 * context, or none, gives 0; a 2D backend has no such bound.
 * @param backend - The backend.
 * @returns The width and height in pixels, both 0 when it has no live context.
 * @throws {never} Never.
 */
export function drawableSize(backend: FilterBackend): Size {
  if (!('tileSize' in backend)) return { width: Infinity, height: Infinity };
  const gl = liveContext(backend);
  if (gl === null) return { width: 0, height: 0 };
  return { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight };
}

/**
 * A backend drawing on a canvas of a given shape, for an export or a preview
 * past the shared square: a canvas of the picture's shape takes the picture's
 * area, where a square of its long side may take many times more. Fabric
 * builds a first context as a square of
 * `tileSize`, which is made 1×1 and given back before the shaped one is made.
 * @param fabric - Fabric.
 * @param fabric.WebGLFilterBackend - Its WebGL filter backend.
 * @param size - The canvas's size.
 * @returns The backend.
 * @throws {never} Never.
 */
export function shapedBackend(
  fabric: Pick<typeof import('fabric'), 'WebGLFilterBackend'>,
  size: Size,
): InstanceType<typeof import('fabric')['WebGLFilterBackend']> {
  const backend = new fabric.WebGLFilterBackend({ tileSize: 1 });
  backend.gl?.getExtension('WEBGL_lose_context')?.loseContext();
  backend.setupGLContext(size.width, size.height);
  return backend;
}

/**
 * Let a shaped backend go, giving its WebGL context back first:
 * Fabric's dispose drops the canvas only, and the browser holds a few contexts
 * at a time.
 * @param backend - The backend.
 * @throws {never} Never.
 */
export function releaseBackend(backend: InstanceType<typeof import('fabric')['WebGLFilterBackend']>): void {
  backend.gl?.getExtension('WEBGL_lose_context')?.loseContext();
  backend.dispose();
}

/** The shaped backend a preview past the shared square draws through, and its canvas's size. */
let heldPreview: { backend: InstanceType<typeof import('fabric')['WebGLFilterBackend']>; size: Size } | null = null;

/**
 * The backend a preview draws through: the shared one while the preview's
 * canvas fits the shared backend's drawing buffer, otherwise a backend shaped
 * to the canvas, up to what the graphics take, so a picture past the shared
 * square zoomed in to 1:1 is drawn at its own pixels. The shaped backend is
 * kept while draws keep its size and its context; it is let go when a draw
 * fits the shared buffer or needs another size, and by the layer when its
 * picture adjust closes. A shaped backend granted a buffer smaller than its
 * canvas does not draw (`drawAdjusted` throws), so the layer stays hidden at
 * that size.
 * @param fabric - Fabric's backend calls.
 * @param natural - The picture's own size.
 * @param asked - The size it is shown at.
 * @returns The backend.
 * @throws {Error} When the shared backend has no WebGL context to draw with.
 */
export function previewBackend(
  fabric: BackendRegistry & Pick<typeof import('fabric'), 'WebGLFilterBackend'>,
  natural: Size,
  asked: Size,
): FilterBackend {
  const shared = liveSharedBackend(fabric);
  const { max } = backendSides(shared);
  const { size } = previewFrame(natural, asked, { width: max, height: max });
  const room = drawableSize(shared);
  if (size.width <= room.width && size.height <= room.height) {
    releasePreviewBackend();
    return shared;
  }
  const held = heldPreview;
  if (held !== null && held.size.width === size.width && held.size.height === size.height && liveContext(held.backend) !== null) {
    return held.backend;
  }
  releasePreviewBackend();
  const backend = shapedBackend(fabric, size);
  heldPreview = { backend, size };
  return backend;
}

/**
 * Let the preview's shaped backend go, if it has one.
 * @throws {never} Never.
 */
export function releasePreviewBackend(): void {
  if (heldPreview === null) return;
  releaseBackend(heldPreview.backend);
  heldPreview = null;
}

/**
 * Draw a picture's preview through the adjust, through the backend
 * {@link previewBackend} picks.
 * @param el - The picture.
 * @param asked - The size it is shown at.
 * @param value - The sliders.
 * @param target - The canvas, resized to the size drawn.
 * @returns Where it drew: the canvas's size and the source pixels it spans.
 * @throws {Error} When Fabric or the filters fail to load, or the backend has no live WebGL context, loses it during the draw, or was given a drawing buffer smaller than its canvas.
 */
export async function drawAdjustedPreview(el: CropSourceEl, asked: Size, value: AdjustValue, target: HTMLCanvasElement): Promise<PreviewFrame> {
  const [fabric] = await loadRuntime();
  return drawAdjusted(el, asked, value, target, previewBackend(fabric, intrinsicSize(el), asked));
}

/**
 * Whether a backend can export a picture this size: a lost context is not a
 * size problem, a drawing buffer narrower or shorter than the picture is.
 * @param backend - The backend the export draws through.
 * @param size - The picture's size in pixels.
 * @throws {ImageTooLargeError} When the backend's drawing buffer is smaller than the picture on either side.
 * @throws {Error} When the backend has no WebGL context to draw with.
 */
export function assertCanExport(backend: FilterBackend, size: Size): void {
  const drawable = drawableSize(backend);
  if (drawable.width === 0) throw new Error(NO_CONTEXT);
  if (drawable.width < size.width || drawable.height < size.height) throw new ImageTooLargeError();
}

/** Where a preview draws: the canvas's size and the source pixels it spans. */
export interface PreviewFrame {
  /** The canvas's size. */
  size: Size;
  /** The source pixels the canvas spans. */
  frame: Size;
}

/**
 * The size a preview draws a picture at: the source shrunk by the largest
 * power of two that still gives the pixels it is shown at, or more when the
 * backend cannot draw that, the canvas rounded up to whole pixels. ffmpeg
 * blurs the chroma per 2x2 block: drawn at its own size the preview is the
 * export, and shrunk by 2 each drawn pixel is one block, so away from the
 * picture's border its chroma is the export's shrunk to that size. Shrunk
 * further, a drawn pixel holds blocks that weigh differently, and its chroma
 * comes close to the export's without matching it, as the luma does.
 * @param natural - The picture's own size.
 * @param asked - The size it is shown at.
 * @param drawable - The largest canvas the backend draws.
 * @returns The canvas's size and the source pixels it spans.
 * @throws {never} Never.
 */
export function previewFrame(natural: Size, asked: Size, drawable: Size): PreviewFrame {
  let factor = 1;
  while (natural.width / (2 * factor) >= asked.width && natural.height / (2 * factor) >= asked.height) factor *= 2;
  while (Math.ceil(natural.width / factor) > drawable.width || Math.ceil(natural.height / factor) > drawable.height) factor *= 2;
  const size = { width: Math.ceil(natural.width / factor), height: Math.ceil(natural.height / factor) };
  return { size, frame: { width: size.width * factor, height: size.height * factor } };
}

/**
 * Export the source through the adjust as a PNG at its own resolution.
 * @param source - The picture.
 * @param value - The sliders.
 * @returns The PNG.
 * @throws {ImageTooLargeError} When its long side is past what the graphics can filter.
 * @throws {Error} When the source fails to load CORS-clean, the graphics have no context to draw with, or the canvas cannot export.
 */
export async function exportAdjustedBlob(source: CropSource, value: AdjustValue): Promise<Blob> {
  const el = await prepareCropSource(source);
  const size = intrinsicSize(el);
  const longSide = Math.max(size.width, size.height);
  const [fabric] = await loadRuntime();
  const shared = liveSharedBackend(fabric);
  const side = exportBackendSide(longSide, backendSides(shared));
  if (side === 'tooLarge') throw new ImageTooLargeError();
  // A backend of its own for a picture past the shared square, released at once.
  const own = side === 'shared' ? undefined : shapedBackend(fabric, size);
  try {
    const through = own ?? shared;
    assertCanExport(through, size);
    const canvas = document.createElement('canvas');
    await drawAdjusted(el, size, value, canvas, through);
    return await pngOf(canvas);
  } finally {
    if (own !== undefined) releaseBackend(own);
  }
}
