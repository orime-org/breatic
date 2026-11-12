// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { captureResize, resizeFromCapture, type CropRect } from '@web/lib/crop-math';

/** The viewfinder's ratios in menu order; `Free` constrains nothing. */
export const VIEWFINDER_RATIOS = ['Free', '16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3'] as const;
export type ViewfinderRatio = (typeof VIEWFINDER_RATIOS)[number];
export const DEFAULT_VIEWFINDER_RATIO: ViewfinderRatio = '16:9';
export type ViewfinderCorner = 'nw' | 'ne' | 'sw' | 'se';
export type ViewfinderRect = CropRect;

/**
 * The width/height a ratio holds the frame to.
 * @param ratio - The menu value.
 * @returns The ratio, or null for Free.
 */
export function viewfinderRatioValue(ratio: ViewfinderRatio): number | null {
  if (ratio === 'Free') return null;
  const [w, h] = ratio.split(':').map(Number);
  return (w ?? 1) / (h ?? 1);
}

/**
 * Where the frame may sit: the viewport less what the chrome around it covers.
 * @param viewport - The viewport size.
 * @param viewport.width - Its width.
 * @param viewport.height - Its height.
 * @param insets - How much each side gives up.
 * @param insets.top - The top inset.
 * @param insets.right - The right inset, an open right panel included.
 * @param insets.bottom - The bottom inset.
 * @param insets.left - The left inset.
 * @returns The safe area, never negative.
 */
export function viewfinderSafeArea(
  viewport: { width: number; height: number },
  insets: { top: number; right: number; bottom: number; left: number },
): ViewfinderRect {
  return {
    x: insets.left,
    y: insets.top,
    width: Math.max(0, viewport.width - insets.left - insets.right),
    height: Math.max(0, viewport.height - insets.top - insets.bottom),
  };
}

/**
 * The largest centred frame of a ratio inside the safe area.
 * @param ratio - The width/height, or null for Free.
 * @param safe - The safe area.
 * @returns The frame; Free takes the whole safe area.
 */
export function largestFrame(ratio: number | null, safe: ViewfinderRect): ViewfinderRect {
  if (ratio === null) return { ...safe };
  let width = safe.width;
  let height = width / ratio;
  if (height > safe.height) { height = safe.height; width = height * ratio; }
  return { x: safe.x + (safe.width - width) / 2, y: safe.y + (safe.height - height) / 2, width, height };
}

/**
 * Drag one corner of the frame; the opposite corner stays put.
 * @param start - The frame when the corner was grabbed.
 * @param corner - The corner.
 * @param cursor - The pointer, in viewport pixels.
 * @param cursor.x - Its x.
 * @param cursor.y - Its y.
 * @param safe - The safe area.
 * @param ratio - The width/height to keep, or null for Free.
 * @param minEdge - The shortest edge the frame may have.
 * @returns The new frame, inside the safe area and no smaller than the minimum.
 */
export function resizeFrame(
  start: ViewfinderRect,
  corner: ViewfinderCorner,
  cursor: { x: number; y: number },
  safe: ViewfinderRect,
  ratio: number | null,
  minEdge: number,
): ViewfinderRect {
  const local = { ...start, x: start.x - safe.x, y: start.y - safe.y };
  const capture = captureResize(local, corner);
  const { anchor } = capture;
  // The frame grows from the anchor toward the grabbed corner only: a cursor past the anchor stops at the minimum.
  const sx = corner.includes('e') ? 1 : -1;
  const sy = corner.includes('s') ? 1 : -1;
  const pointer = {
    x: sx > 0 ? Math.max(cursor.x - safe.x, anchor.x) : Math.min(cursor.x - safe.x, anchor.x),
    y: sy > 0 ? Math.max(cursor.y - safe.y, anchor.y) : Math.min(cursor.y - safe.y, anchor.y),
  };
  const next = resizeFromCapture(capture, pointer, { width: safe.width, height: safe.height }, ratio);
  let { width, height } = next;
  if (ratio === null) {
    width = Math.max(width, minEdge);
    height = Math.max(height, minEdge);
  } else if (Math.min(width, height) < minEdge) {
    if (ratio < 1) { width = minEdge; height = minEdge / ratio; } else { height = minEdge; width = minEdge * ratio; }
  }
  const x = sx > 0 ? anchor.x : anchor.x - width;
  const y = sy > 0 ? anchor.y : anchor.y - height;
  return { x: x + safe.x, y: y + safe.y, width, height };
}

/**
 * Put the frame back after the safe area changed: scale it about its relative
 * centre only as much as it must shrink, then keep it inside.
 * @param frame - The frame.
 * @param from - The safe area it was placed in.
 * @param to - The new safe area.
 * @returns The refitted frame; its ratio is unchanged.
 */
export function refitFrame(frame: ViewfinderRect, from: ViewfinderRect, to: ViewfinderRect): ViewfinderRect {
  const k = Math.min(1, to.width / frame.width, to.height / frame.height);
  const cx = to.x + ((frame.x + frame.width / 2 - from.x) / (from.width || 1)) * to.width;
  const cy = to.y + ((frame.y + frame.height / 2 - from.y) / (from.height || 1)) * to.height;
  const width = frame.width * k;
  const height = frame.height * k;
  return {
    x: Math.min(Math.max(cx - width / 2, to.x), to.x + to.width - width),
    y: Math.min(Math.max(cy - height / 2, to.y), to.y + to.height - height),
    width,
    height,
  };
}

/**
 * The size of the image a frame captures.
 * @param frame - The frame.
 * @param longEdge - The long edge of a capture, in pixels.
 * @returns The image size, its short edge rounded.
 */
export function captureSize(frame: ViewfinderRect, longEdge: number): { width: number; height: number } {
  return frame.width >= frame.height
    ? { width: longEdge, height: Math.round((longEdge * frame.height) / frame.width) }
    : { width: Math.round((longEdge * frame.width) / frame.height), height: longEdge };
}

/**
 * The camera view offset that renders exactly the frame at the capture size.
 * @param frame - The frame, in viewport pixels.
 * @param viewport - The viewport size.
 * @param viewport.width - Its width.
 * @param viewport.height - Its height.
 * @param size - The capture size.
 * @param size.width - Its width.
 * @param size.height - Its height.
 * @returns The arguments for `PerspectiveCamera.setViewOffset`.
 */
export function captureViewOffset(
  frame: ViewfinderRect,
  viewport: { width: number; height: number },
  size: { width: number; height: number },
): { fullWidth: number; fullHeight: number; x: number; y: number; width: number; height: number } {
  const k = size.width / frame.width;
  return {
    fullWidth: viewport.width * k,
    fullHeight: viewport.height * k,
    x: frame.x * k,
    y: frame.y * k,
    width: size.width,
    height: size.height,
  };
}
