// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Where the avatar crop box lives, and how big it starts.
 *
 * Both are expressed against the IMAGE's drawn area rather than the frame
 * around it. An image whose aspect ratio differs from the frame's is drawn
 * with letterbox margins, and a selection allowed onto those margins crops in
 * a band of empty space — which is what the user would then be stuck with as
 * their avatar.
 *
 * The rect maths itself is the canvas crop tool's, reused rather than
 * reimplemented; this module only supplies the bounds those functions work
 * within.
 */

import {
  applyRatioPreset,
  type CropRect,
  type CropSize,
} from '@web/spaces/canvas/focus/crop-math';

/** The subset of `DOMRect` the measurement needs. */
export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The image's drawn area, positioned relative to its frame. */
export interface ImageBox extends CropSize {
  x: number;
  y: number;
}

/**
 * Locate the image's drawn area inside its frame.
 *
 * `null` means "not measurable yet", which is a state worth distinguishing:
 * a dialog that has not been shown measures 0×0, and seeding a crop from that
 * leaves a zero-sized selection that never recovers once the dialog appears.
 * Callers hold off until a real box arrives.
 * @param frame - The frame element's rect.
 * @param image - The image element's rect.
 * @returns The drawn area relative to the frame, or `null` when either is
 *   not laid out yet.
 */
export function imageBoxWithin(
  frame: RectLike,
  image: RectLike,
): ImageBox | null {
  if (frame.width <= 0 || frame.height <= 0) return null;
  if (image.width <= 0 || image.height <= 0) return null;
  return {
    x: image.left - frame.left,
    y: image.top - frame.top,
    width: image.width,
    height: image.height,
  };
}

/**
 * The starting selection: the largest square that fits the image, centred.
 * @param box - The image's drawn size.
 * @returns The initial 1:1 crop rect, in the image's display pixels.
 */
export function initialSquareCrop(box: CropSize): CropRect {
  // Seeding with the full box lets the ratio maths shrink to whichever side
  // is shorter, which is exactly "the biggest square that fits", centred.
  return applyRatioPreset({ x: 0, y: 0, ...box }, 1, box);
}
