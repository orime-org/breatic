// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** The closest zoom, in pixels per frame. */
export const TIMELINE_MAX_PIXELS_PER_FRAME = 12;

const RULER_LABEL_GAP_PX = 48;
const RULER_MAX_LABELS = 400;
const RULER_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

/**
 * The farthest zoom: the whole extent fits the visible track width.
 * @param extentFrames - The Timeline extent in frames.
 * @param viewportPx - The visible track width in pixels.
 * @returns Pixels per frame, never above the closest zoom.
 * @throws {never} Never.
 */
export function timelineMinZoom(extentFrames: number, viewportPx: number): number {
  return Math.min(TIMELINE_MAX_PIXELS_PER_FRAME, Math.max(1, viewportPx) / Math.max(1, extentFrames));
}

/**
 * Seconds between ruler labels: labels keep RULER_LABEL_GAP_PX apart and number at most RULER_MAX_LABELS over the extent.
 * @param fps - Frames per second.
 * @param pixelsPerFrame - The current zoom.
 * @param extentFrames - The Timeline extent in frames.
 * @returns The label step in whole seconds.
 * @throws {never} Never.
 */
export function timelineRulerStep(fps: number, pixelsPerFrame: number, extentFrames: number): number {
  const seconds = extentFrames / fps;
  /**
   * Whether labels every `step` seconds keep their gap and count.
   * @param step - Seconds between labels.
   * @returns True when the step works.
   * @throws {never} Never.
   */
  const fits = (step: number): boolean => step * fps * pixelsPerFrame >= RULER_LABEL_GAP_PX && seconds / step <= RULER_MAX_LABELS;
  const listed = RULER_STEPS.find(fits);
  if (listed !== undefined) return listed;
  let step = RULER_STEPS[RULER_STEPS.length - 1] ?? 1;
  while (!fits(step) && Number.isFinite(step * 2)) step *= 2;
  return step;
}
