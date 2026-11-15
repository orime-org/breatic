// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { conformedTime, presentationConform } from "@shared/mini-tools/video-encode-plan.js";
import { presentationRunOffsets, type VideoPresentationTable } from "@shared/mini-tools/video-presentation-projection.js";

/** The model input's frame grid: the range frame for frame at its average rate, or resampled at the model's top rate. */
export interface ModelGrid { mode: "frames" | "resample"; rate: number; frameCount: number }

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
    if (frames[middle]!.start <= time + EPSILON) low = middle;
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
  return Math.min(grid.frameCount - 1, Math.floor((frames[frame]!.start - frames[0]!.start) * grid.rate + EPSILON));
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
 * A table's frames as a grid reads them (§7.17 rounding clock row): on a table whose clock rounded a constant rate's frame
 * times, every frame from the second on starts on its conform grid point and ends where the next one starts; the first
 * frame keeps the presentation's start and the last frame its end.
 * @param table - The presentation table.
 * @param startFrame - The first frame.
 * @param count - How many frames.
 * @returns The frames' intervals in seconds.
 * @throws {RangeError} When the frames lie outside the table.
 */
export function presentationGridFrames(table: VideoPresentationTable, startFrame: number, count: number): GridFrame[] {
  const offsets = presentationRunOffsets(table);
  const total = offsets.at(-1)!;
  if (startFrame < 0 || startFrame + count > total) throw new RangeError("Frames lie outside the presentation table");
  const conform = presentationConform(table);
  const scale = BigInt(table.timescale);
  // The stored starts and ends of the frames and of the one after them, walking the runs once.
  const starts: number[] = [];
  const ends: number[] = [];
  let run = 0;
  while (offsets[run + 1]! <= startFrame) run += 1;
  for (let index = startFrame; index <= startFrame + count && index < total; index += 1) {
    while (offsets[run + 1]! <= index) run += 1;
    const entry = table.runs[run]!;
    const start = entry.start + (index - offsets[run]!) * entry.step;
    starts.push(start);
    ends.push(start + entry.duration);
  }
  /**
   * Where a frame starts on the grid.
   * @param index - The frame.
   * @param start - Its stored start in ticks.
   * @returns The time in seconds.
   * @throws {never} Never.
   */
  const bound = (index: number, start: number): number => {
    if (conform === null || index === 0) return start / table.timescale;
    const [numerator, denominator] = conformedTime(conform, [BigInt(start), scale]);
    return Number(numerator) / Number(denominator);
  };
  return Array.from({ length: count }, (_unused, at) => {
    const index = startFrame + at;
    const start = bound(index, starts[at]!);
    return { start, end: conform === null || index + 1 === total ? ends[at]! / table.timescale : bound(index + 1, starts[at + 1]!) };
  });
}
