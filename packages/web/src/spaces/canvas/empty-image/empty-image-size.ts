// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Pure sizing math for the "reset to empty image" panel (#1623): dimension
 * clamping and ratio-preset → concrete W×H, decoupled from any DOM / canvas so
 * it is fully unit-testable (the actual PNG rasterisation in
 * `generate-blank-png.ts` needs a browser canvas and is covered by smoke).
 */

/** Smallest allowed side, in pixels (D3, user-ratified 2026-07-20). */
export const EMPTY_IMAGE_MIN = 16;
/** Largest allowed side, in pixels (D3). */
export const EMPTY_IMAGE_MAX = 4096;
/** Default side for a fresh panel and the ratio-preset anchor long edge (D3). */
export const EMPTY_IMAGE_DEFAULT = 1024;

/** A concrete integer pixel size for the blank image. */
export interface EmptyImageSize {
  width: number;
  height: number;
}

/**
 * Sanitise one user-entered dimension: round to an integer and clamp into
 * `[EMPTY_IMAGE_MIN, EMPTY_IMAGE_MAX]`. `NaN` (empty / garbage field) falls
 * back to the minimum so a blank field can never produce an invalid size;
 * `±Infinity` clamp naturally to the max / min bound.
 * @param value - The raw dimension (may be fractional / out of range / NaN).
 * @returns An integer within `[EMPTY_IMAGE_MIN, EMPTY_IMAGE_MAX]`.
 */
export function clampDimension(value: number): number {
  if (Number.isNaN(value)) return EMPTY_IMAGE_MIN;
  return Math.min(EMPTY_IMAGE_MAX, Math.max(EMPTY_IMAGE_MIN, Math.round(value)));
}

/**
 * Resolve a ratio preset (`width / height`) to a concrete W×H anchored on
 * `EMPTY_IMAGE_DEFAULT` as the long edge, then shrink-to-fit into
 * `[EMPTY_IMAGE_MIN, EMPTY_IMAGE_MAX]` while preserving the ratio (M3). For the
 * canvas's ratio presets (≤ 16:9) the anchored size already fits, so the fit
 * pass is a defensive no-op; it keeps the function correct for any ratio.
 * @param ratio - The target aspect ratio as `width / height` (> 0).
 * @returns Integer `{ width, height }` matching the ratio within bounds.
 */
export function sizeForRatio(ratio: number): EmptyImageSize {
  let width = ratio >= 1 ? EMPTY_IMAGE_DEFAULT : EMPTY_IMAGE_DEFAULT * ratio;
  let height = ratio >= 1 ? EMPTY_IMAGE_DEFAULT / ratio : EMPTY_IMAGE_DEFAULT;
  // Shrink-to-fit if the long edge overshoots MAX, then grow-to-fit if the
  // short edge undershoots MIN — both scale BOTH axes so the ratio is kept.
  const shrink = Math.min(1, EMPTY_IMAGE_MAX / Math.max(width, height));
  width *= shrink;
  height *= shrink;
  const grow = Math.max(1, EMPTY_IMAGE_MIN / Math.min(width, height));
  width *= grow;
  height *= grow;
  return { width: clampDimension(width), height: clampDimension(height) };
}
