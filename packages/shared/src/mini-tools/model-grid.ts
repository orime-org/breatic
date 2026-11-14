// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The model input's frame grid: the range frame for frame at its average rate, or resampled at the model's top rate. `slack`
 * is half a tick of the source's time base in seconds: a source stores frame times rounded to its clock, so a frame starting
 * up to `slack` after a slot time starts on that slot.
 */
export interface ModelGrid { mode: "frames" | "resample"; rate: number; frameCount: number; slack?: number }

/** A presented frame's interval in seconds. */
interface GridFrame { start: number; end: number }

const EPSILON = 1e-9;

/**
 * The model grid of a range (execution design §10.4): at an average presentation rate of at most `maxFps` the model input
 * maps frame for frame at that average rate; above it the range is resampled on a `maxFps` grid of ceil(duration × maxFps)
 * slots. Model input preparation, the mask and the composite all read this grid.
 * @param frames - The range's presented frames in order.
 * @param maxFps - The highest rate the model keeps frame for frame.
 * @returns The grid.
 * @throws {RangeError} When there are no frames.
 */
export function modelGrid(frames: readonly GridFrame[], maxFps: number): ModelGrid {
  if (frames.length === 0) throw new RangeError("A model grid needs at least one frame");
  const duration = frames.at(-1)!.end - frames[0]!.start;
  const average = frames.length / duration;
  if (average <= maxFps + EPSILON) return { mode: "frames", rate: average, frameCount: frames.length };
  return { mode: "resample", rate: maxFps, frameCount: Math.ceil(duration * maxFps - EPSILON) };
}

/**
 * The range frame a grid slot shows: slot j itself frame for frame, else the frame covering start + j / rate.
 * @param grid - The grid.
 * @param frames - The range's presented frames in order.
 * @param slot - The slot.
 * @returns The frame's index in the range.
 * @throws {never} Never.
 */
export function gridSlotFrame(grid: ModelGrid, frames: readonly GridFrame[], slot: number): number {
  if (grid.mode === "frames") return slot;
  const time = frames[0]!.start + slot / grid.rate;
  let low = 0;
  let high = frames.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (frames[middle]!.start <= time + (grid.slack ?? 0) + EPSILON) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * The grid slot a range frame takes: itself frame for frame, else the last slot whose time is not after the frame's start.
 * @param grid - The grid.
 * @param frames - The range's presented frames in order.
 * @param frame - The frame's index in the range.
 * @returns The slot.
 * @throws {never} Never.
 */
export function gridFrameSlot(grid: ModelGrid, frames: readonly GridFrame[], frame: number): number {
  if (grid.mode === "frames") return frame;
  return Math.min(grid.frameCount - 1, Math.floor((frames[frame]!.start - frames[0]!.start + (grid.slack ?? 0)) * grid.rate + EPSILON));
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
