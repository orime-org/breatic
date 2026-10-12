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
import { UNIT_FRAME, type ExpandFrame, type ExpandRatio } from '@web/stores/expand-draft';

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

/**
 * Whether the frame reaches past the source on any side.
 * @param frame - The frame.
 * @returns True when it does.
 */
export function isExpanded(frame: ExpandFrame): boolean {
  return frame.x < -EPS || frame.y < -EPS || frame.x + frame.width > 1 + EPS || frame.y + frame.height > 1 + EPS;
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
  if (value === null) return isExpanded(current) ? current : UNIT_FRAME;
  const frame = wrapping(value, source);
  return isExpanded(frame) ? frame : UNIT_FRAME;
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
 * and stops where the side would pass the cap.
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
 * source, and on a corner the opposite corner stays.
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
  const x = handle.includes('w') ? right - width : handle.includes('e') ? frame.x : 0.5 - width / 2;
  const y = handle.includes('n') ? bottom - height : handle.includes('s') ? frame.y : 0.5 - height / 2;
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
