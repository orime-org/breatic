// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The expand frame's geometry (inner#1303 §6.3).
 *
 * A frame is held as shares of the source: the source is the rectangle from
 * 0,0 to 1,1, and the frame always contains it. A ratio is a pixel ratio,
 * width over height, and the long-side cap is in source pixels; both are
 * turned into shares through the source's pixel size.
 */

import type { CropHandle } from '@web/lib/crop-math';
import { UNIT_FRAME, type ExpandDraft, type ExpandFrame, type ExpandRatio } from '@web/stores/expand-draft';

export { EXPAND_RATIOS, UNIT_FRAME, type ExpandFrame, type ExpandRatio } from '@web/stores/expand-draft';

/** A source's pixel size. */
export interface PixelSize {
  width: number;
  height: number;
}


/** Below this a difference in shares is rounding. */
const EPS = 1e-6;

/**
 * A number held between two bounds.
 * @param value - The number.
 * @param min - The lower bound.
 * @param max - The upper bound.
 * @returns The held number.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * A ratio's width over height in pixels.
 * @param ratio - The ratio.
 * @returns The number, or null for Free.
 */
export function ratioValue(ratio: ExpandRatio): number | null {
  if (ratio === 'free') return null;
  const [w, h] = ratio.split(':').map(Number);
  return (w ?? 1) / (h ?? 1);
}

/** The padded canvas's size and where the source's top left sits on it, in source pixels. */
export interface ExpandLayout {
  width: number;
  height: number;
  sourceX: number;
  sourceY: number;
}

/**
 * Lay the source on the frame's canvas in whole pixels, never cutting into it.
 * @param frame - The frame, as shares of the source.
 * @param source - The source's pixels.
 * @returns The canvas size and the source's offset on it.
 */
export function expandLayout(frame: ExpandFrame, source: PixelSize): ExpandLayout {
  const sourceX = Math.round(-frame.x * source.width);
  const sourceY = Math.round(-frame.y * source.height);
  return {
    width: Math.max(sourceX + source.width, Math.round(frame.width * source.width)),
    height: Math.max(sourceY + source.height, Math.round(frame.height * source.height)),
    sourceX,
    sourceY,
  };
}

/**
 * Whether the frame pads the source by at least one pixel on some side, read
 * from the same whole-pixel layout the export draws.
 * @param frame - The frame.
 * @param source - The source's pixels.
 * @returns True when the export would be larger than the source.
 * @throws {never} Never.
 */
export function isExpanded(frame: ExpandFrame, source: PixelSize): boolean {
  const layout = expandLayout(frame, source);
  return layout.width > source.width || layout.height > source.height;
}

/**
 * The smallest frame of a ratio that wraps the source, centred on it.
 * @param ratio - The pixel ratio.
 * @param source - The source's pixels.
 * @returns The frame.
 */
function wrapping(ratio: number, source: PixelSize): ExpandFrame {
  if (ratio >= source.width / source.height) {
    const width = (source.height * ratio) / source.width;
    return { x: (1 - width) / 2, y: 0, width, height: 1 };
  }
  const height = source.width / ratio / source.height;
  return { x: 0, y: (1 - height) / 2, width: 1, height };
}

/**
 * The frame a ratio preset sets: Free keeps an expanded frame and leaves an
 * unexpanded one at the source; a fixed ratio wraps the source in the smallest
 * frame of that ratio, centred on it.
 * @param ratio - The preset.
 * @param source - The source's pixels.
 * @param current - The frame now.
 * @returns The frame.
 */
export function frameForRatio(ratio: ExpandRatio, source: PixelSize, current: ExpandFrame): ExpandFrame {
  const value = ratioValue(ratio);
  if (value === null) return isExpanded(current, source) ? current : UNIT_FRAME;
  const frame = wrapping(value, source);
  return isExpanded(frame, source) ? frame : UNIT_FRAME;
}

/**
 * Whether a ratio's wrapping frame stays within the long-side cap.
 * @param ratio - The preset.
 * @param source - The source's pixels.
 * @param cap - The longest side the model takes, in pixels.
 * @returns True for Free, and for a ratio whose frame fits.
 */
export function ratioFits(ratio: ExpandRatio, source: PixelSize, cap: number): boolean {
  const value = ratioValue(ratio);
  if (value === null) return true;
  const frame = wrapping(value, source);
  return Math.max(frame.width * source.width, frame.height * source.height) <= cap + EPS;
}

/**
 * Whether the source cannot grow at all: longer than the cap, or at the cap
 * both ways.
 * @param source - The source's pixels.
 * @param cap - The longest side the model takes.
 * @returns True when no direction is left.
 */
export function sourceTooLargeToExpand(source: PixelSize, cap: number): boolean {
  return Math.max(source.width, source.height) > cap || (source.width >= cap && source.height >= cap);
}

/**
 * A free drag: each dragged edge follows the pointer, stays outside the source
 * and stops where the side would pass the cap; nothing moves on a source
 * already past it.
 * @param frame - The frame at the start.
 * @param handle - The handle.
 * @param pointer - The pointer, in shares of the source.
 * @param pointer.x - Its x.
 * @param pointer.y - Its y.
 * @param max - The cap as shares of the source.
 * @param max.width - Across.
 * @param max.height - Down.
 * @returns The frame.
 */
function resizeFree(
  frame: ExpandFrame,
  handle: CropHandle,
  pointer: { x: number; y: number },
  max: PixelSize,
): ExpandFrame {
  // A source past the cap has no room to grow into either way.
  if (max.width < 1 || max.height < 1) return frame;
  let left = frame.x;
  let right = frame.x + frame.width;
  let top = frame.y;
  let bottom = frame.y + frame.height;
  if (handle.includes('e')) right = clamp(pointer.x, 1, left + max.width);
  if (handle.includes('w')) left = clamp(pointer.x, right - max.width, 0);
  if (handle.includes('s')) bottom = clamp(pointer.y, 1, top + max.height);
  if (handle.includes('n')) top = clamp(pointer.y, bottom - max.height, 0);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * A drag held to a ratio. The dragged edge moves and the opposite one stays;
 * on a side handle the other direction follows the ratio, centred on the
 * frame's own middle and held just far enough to keep wrapping the source,
 * and on a corner the opposite corner stays.
 * @param frame - The frame at the start.
 * @param handle - The handle.
 * @param pointer - The pointer, in shares of the source.
 * @param pointer.x - Its x.
 * @param pointer.y - Its y.
 * @param shareRatio - The ratio as width over height in shares.
 * @param max - The cap as shares of the source.
 * @param max.width - Across.
 * @param max.height - Down.
 * @returns The frame.
 */
function resizeLocked(
  frame: ExpandFrame,
  handle: CropHandle,
  pointer: { x: number; y: number },
  shareRatio: number,
  max: PixelSize,
): ExpandFrame {
  const right = frame.x + frame.width;
  const bottom = frame.y + frame.height;
  const across = handle.includes('e') ? pointer.x - frame.x : handle.includes('w') ? right - pointer.x : null;
  const down = handle.includes('s') ? pointer.y - frame.y : handle.includes('n') ? bottom - pointer.y : null;
  const wanted = Math.max(across ?? 0, (down ?? 0) * shareRatio);
  // The frame has to wrap the source both ways and stay under the cap both ways.
  let least = Math.max(1, shareRatio);
  if (handle.includes('e')) least = Math.max(least, 1 - frame.x);
  if (handle.includes('w')) least = Math.max(least, right);
  if (handle.includes('s')) least = Math.max(least, (1 - frame.y) * shareRatio);
  if (handle.includes('n')) least = Math.max(least, bottom * shareRatio);
  const most = Math.min(max.width, max.height * shareRatio);
  if (least > most + EPS) return frame;
  const width = clamp(wanted, least, most);
  const height = width / shareRatio;
  // As the crop box does (crop-math.ts), so a picture moved inside the frame stays where it is.
  const middleX = clamp(frame.x + frame.width / 2 - width / 2, 1 - width, 0);
  const middleY = clamp(frame.y + frame.height / 2 - height / 2, 1 - height, 0);
  const x = handle.includes('w') ? right - width : handle.includes('e') ? frame.x : middleX;
  const y = handle.includes('n') ? bottom - height : handle.includes('s') ? frame.y : middleY;
  return { x, y, width, height };
}

/**
 * Drag a handle of the frame.
 * @param frame - The frame at the start of the move.
 * @param handle - The handle.
 * @param pointer - The pointer, in shares of the source.
 * @param pointer.x - Its x.
 * @param pointer.y - Its y.
 * @param ratio - The preset the frame is held to.
 * @param source - The source's pixels.
 * @param cap - The longest side the model takes, in pixels.
 * @returns The frame, wrapping the source and within the cap.
 */
export function resizeFrame(
  frame: ExpandFrame,
  handle: CropHandle,
  pointer: { x: number; y: number },
  ratio: ExpandRatio,
  source: PixelSize,
  cap: number,
): ExpandFrame {
  const max = { width: cap / source.width, height: cap / source.height };
  const value = ratioValue(ratio);
  if (value === null) return resizeFree(frame, handle, pointer, max);
  return resizeLocked(frame, handle, pointer, (value * source.height) / source.width, max);
}

/**
 * Move the source inside the frame: the frame keeps its size and slides the
 * other way, and the source stops at the frame's edges.
 * @param frame - The frame at the start of the move.
 * @param delta - How far the source moves, in shares of it.
 * @param delta.x - Across.
 * @param delta.y - Down.
 * @returns The frame.
 */
export function moveSource(frame: ExpandFrame, delta: { x: number; y: number }): ExpandFrame {
  return {
    x: clamp(frame.x - delta.x, 1 - frame.width, 0),
    y: clamp(frame.y - delta.y, 1 - frame.height, 0),
    width: frame.width,
    height: frame.height,
  };
}

/**
 * How far the frame reaches below its node, for the panel hung under it. Read
 * from the draft and the node's size, which the canvas keeps while the node
 * itself is off screen and not drawn.
 * @param expand - The frame, how far the picture moved in it, and where the node shows the picture.
 * @param nodeHeight - The node's height, in canvas pixels.
 * @param zoom - The canvas zoom.
 * @returns The reach in screen pixels, 0 when the frame ends inside the node.
 */
export function expandDrop(
  expand: Pick<ExpandDraft, 'frame' | 'shift' | 'view'>,
  nodeHeight: number,
  zoom: number,
): number {
  const { frame, shift, view } = expand;
  if (view === null) return 0;
  const bottom = view.at.y + (frame.y + shift.y + frame.height) * view.box.height;
  return Math.max(0, bottom - nodeHeight) * zoom;
}
