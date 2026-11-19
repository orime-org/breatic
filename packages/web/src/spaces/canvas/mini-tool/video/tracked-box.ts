// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The box that follows a tracked object (inner#1306 execution design §10.3 overlay paragraph): the foreground's bounding box
 * of the RLE frame for the presented frame, normalized to the frame.
 */
import { decodeCocoRleMask, type CocoMaskSize, type CocoRleMask } from '@breatic/shared/mini-tools';

/** A normalized box. */
export interface TrackedBox { x: number; y: number; width: number; height: number }

/**
 * The tracked box on one presented frame.
 * @param masks - The RLE frames of the range, null where a frame has no mask.
 * @param range - The range's first presentation frame and its frame count.
 * @param range.startFrame - Its first frame.
 * @param range.frameCount - Its frame count.
 * @param frame - The presented frame.
 * @param size - The masks' pixel size.
 * @returns The box, or null outside the range or on a frame without foreground.
 * @throws {RangeError} When a mask does not decode at the size.
 */
export function trackedBox(masks: readonly (CocoRleMask | null)[], range: { startFrame: number; frameCount: number }, frame: number, size: CocoMaskSize): TrackedBox | null {
  const at = frame - range.startFrame;
  const mask = at >= 0 && at < range.frameCount ? masks[at] : null;
  if (mask === null || mask === undefined) return null;
  // Foreground decodes to 0, background to 255.
  const pixels = decodeCocoRleMask(mask, size);
  let [left, top, right, bottom] = [size.width, size.height, -1, -1];
  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      if (pixels[y * size.width + x] !== 0) continue;
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  if (right < 0) return null;
  return { x: left / size.width, y: top / size.height, width: (right - left + 1) / size.width, height: (bottom - top + 1) / size.height };
}
