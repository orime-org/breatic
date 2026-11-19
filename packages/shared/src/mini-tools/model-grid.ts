// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { FrameRate } from "@shared/upload/frame-grid-rate.js";

/** The model input's frame grid: the range frame for frame at the grid fps, or resampled at the model's top rate. */
export interface ModelGrid { mode: "frames" | "resample"; rate: number; frameCount: number }

const EPSILON = 1e-9;

/**
 * Frames per second of a grid rate.
 * @param fps - The exact rate.
 * @returns Its value.
 * @throws {never} Never.
 */
function perSecond(fps: FrameRate): number {
  return fps.numerator / fps.denominator;
}

/**
 * The model grid of a range of grid frames (execution design §10.4; frames-split §7.16): at a grid fps of at most
 * `maxFps` the model input maps frame for frame at that fps; above it the range is resampled on a `maxFps` grid of
 * ceil(frames ÷ fps × maxFps) slots. Model input preparation, the mask and the composite all read this grid.
 * @param frameCount - The range's grid frames.
 * @param fps - The grid fps.
 * @param maxFps - The highest rate the model keeps frame for frame.
 * @returns The grid.
 * @throws {RangeError} When there are no frames.
 */
export function modelGrid(frameCount: number, fps: FrameRate, maxFps: number): ModelGrid {
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0) throw new RangeError("A model grid needs at least one frame");
  const rate = perSecond(fps);
  if (rate <= maxFps + EPSILON) return { mode: "frames", rate, frameCount };
  return { mode: "resample", rate: maxFps, frameCount: Math.ceil((frameCount / rate) * maxFps - EPSILON) };
}

/**
 * The range frame a model slot shows: slot j itself frame for frame, else the grid frame covering j / rate from the range start.
 * @param grid - The model grid.
 * @param fps - The grid fps.
 * @param slot - The slot.
 * @returns The frame's index in the range.
 * @throws {never} Never.
 */
export function gridSlotFrame(grid: ModelGrid, fps: FrameRate, slot: number): number {
  if (grid.mode === "frames") return slot;
  return Math.floor((slot / grid.rate) * perSecond(fps) + EPSILON);
}

/**
 * The model slot a range frame takes: itself frame for frame, else the last slot whose time is not after the frame's start.
 * @param grid - The model grid.
 * @param fps - The grid fps.
 * @param frame - The frame's index in the range.
 * @returns The slot.
 * @throws {never} Never.
 */
export function gridFrameSlot(grid: ModelGrid, fps: FrameRate, frame: number): number {
  if (grid.mode === "frames") return frame;
  return Math.min(grid.frameCount - 1, Math.floor((frame / perSecond(fps)) * grid.rate + EPSILON));
}

/**
 * Whether the model input lasts from `minSeconds` to `maxSeconds` (execution design §10.4 duration row).
 * @param grid - The grid.
 * @param bounds - The model's bounds.
 * @param bounds.minSeconds - The shortest input.
 * @param bounds.maxSeconds - The longest input.
 * @returns True inside the bounds.
 * @throws {never} Never.
 */
export function gridSecondsAllowed(grid: ModelGrid, bounds: { minSeconds: number; maxSeconds: number }): boolean {
  const seconds = grid.frameCount / grid.rate;
  return seconds >= bounds.minSeconds - EPSILON && seconds <= bounds.maxSeconds + EPSILON;
}

/**
 * The grid frames a model window's span in grid seconds shows (execution design §10.5): from the frame covering the span's
 * start to the last frame starting before its end, at least one, inside [0, frameCount).
 * @param span - The span in grid seconds.
 * @param span.start - Its start.
 * @param span.end - Its end.
 * @param fps - The grid fps.
 * @param frameCount - The grid's frame count.
 * @returns The frame window.
 * @throws {never} Never.
 */
export function gridSpanFrames(span: { start: number; end: number }, fps: FrameRate, frameCount: number): { start: number; end: number } {
  const rate = perSecond(fps);
  const start = Math.min(frameCount - 1, Math.max(0, Math.floor(span.start * rate + EPSILON)));
  const last = Math.min(frameCount - 1, Math.ceil(span.end * rate - EPSILON) - 1);
  return { start, end: Math.max(start, last) + 1 };
}
