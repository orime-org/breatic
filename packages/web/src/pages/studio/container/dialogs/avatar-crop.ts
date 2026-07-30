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

/** The image's offset box: its size, and where it sits inside its frame. */
export interface OffsetBox {
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
 * Both inputs must be LAYOUT measurements (`offsetWidth` / `offsetLeft` and
 * friends), not `getBoundingClientRect`. The dialog animates in with a scale
 * transform, and `getBoundingClientRect` reports the transformed size — while
 * the `ResizeObserver` that drives re-measurement only fires on layout
 * changes, which a transform is not. Mixing the two means the one measurement
 * that ever happens is taken mid-animation, at ~95% of the real size, and
 * nothing ever corrects it. That shipped as a crop box noticeably too small
 * with its top edge a pixel outside the image.
 *
 * `null` means "not measurable yet": a dialog that has not been shown measures
 * 0×0, and seeding a crop from that leaves a zero-sized selection that never
 * recovers. Callers hold off until a real box arrives.
 * @param frame - The frame's layout size.
 * @param image - The image's layout offset box, relative to that frame.
 * @returns The drawn area relative to the frame, or `null` when either is
 *   not laid out yet.
 */
export function imageBoxWithin(
  frame: CropSize,
  image: OffsetBox,
): ImageBox | null {
  if (frame.width <= 0 || frame.height <= 0) return null;
  if (image.width <= 0 || image.height <= 0) return null;
  return {
    x: image.left,
    y: image.top,
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

/**
 * Carry a selection across a change in the image's drawn size.
 *
 * The image is measured more than once: the dialog animates open, so the first
 * measurement is of a box that is still growing, and the window can be resized
 * mid-crop. A selection left at its original numbers then belongs to a box
 * that no longer exists — in a browser that showed up as a selection about 5%
 * too small with its top edge a pixel above the image.
 *
 * The scale is taken from the smaller axis ratio and applied to both, so the
 * selection stays square even if the two axes somehow scaled differently, and
 * the result is clamped back inside the new box.
 * @param rect - The selection, in the old box's coordinates.
 * @param from - The box it was measured against.
 * @param to - The box it should now fit.
 * @returns The rescaled selection, or `rect` itself when nothing changed.
 */
export function rescaleCrop(
  rect: CropRect,
  from: CropSize,
  to: CropSize,
): CropRect {
  if (from.width <= 0 || from.height <= 0) return rect;
  if (from.width === to.width && from.height === to.height) return rect;
  const scale = Math.min(to.width / from.width, to.height / from.height);
  const size = Math.min(rect.width * scale, to.width, to.height);
  return {
    x: clamp(rect.x * scale, 0, to.width - size),
    y: clamp(rect.y * scale, 0, to.height - size),
    width: size,
    height: size,
  };
}

/**
 * Clamp a value into `[min, max]`.
 * @param v - The value.
 * @param min - Lower bound.
 * @param max - Upper bound.
 * @returns The clamped value.
 */
function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}
