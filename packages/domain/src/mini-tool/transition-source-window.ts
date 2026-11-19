// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { FrameRate } from "@breatic/shared";
import type { FrameWindow } from "@breatic/shared/mini-tools";

/** A clip's place on a transition's output frame grid: its first output frame and its In frame on that grid. */
export interface TransitionClipPlace { startFrame: number; inFrame: number }

/**
 * The time in a clip's grid that output frame `k` shows (frames-split §7.17 transition output profile row: each clip takes, at
 * output frame k, the grid frame covering that moment), exact.
 * @param clip - The clip's place on the output grid.
 * @param k - The output frame.
 * @param fps - The output frame rate.
 * @returns The time in seconds as a numerator and denominator.
 * @throws {never} Never.
 */
export function transitionSlotTime(clip: TransitionClipPlace, k: number, fps: FrameRate): [bigint, bigint] {
  return [BigInt(clip.inFrame + k - clip.startFrame) * BigInt(fps.denominator), BigInt(fps.numerator)];
}

/**
 * The grid frame covering an exact time (§4.1: frame i covers [i/fps, (i+1)/fps)): floor(t × fps).
 * @param grid - The clip's grid rate and frame count.
 * @param grid.fps - Its fps.
 * @param grid.frameCount - Its frames.
 * @param at - The time in seconds as a numerator and a positive denominator.
 * @returns The grid frame.
 * @throws {RangeError} When the time lies outside the grid.
 */
export function gridFrameCovering(grid: { fps: FrameRate; frameCount: number }, at: readonly [bigint, bigint]): number {
  const [numerator, denominator] = at;
  const top = numerator * BigInt(grid.fps.numerator);
  const bottom = denominator * BigInt(grid.fps.denominator);
  if (top < 0n) throw new RangeError("No grid frame covers a time before the grid");
  const frame = Number(top / bottom);
  if (frame >= grid.frameCount) throw new RangeError("No grid frame covers a time after the grid");
  return frame;
}

/**
 * The grid frames a clip shows over output frames `[start, end)`: from the frame covering the first output frame's time to
 * the one covering the last's.
 * @param grid - The clip's grid rate and frame count.
 * @param grid.fps - Its fps.
 * @param grid.frameCount - Its frames.
 * @param clip - The clip's place on the output grid.
 * @param output - The output frames.
 * @param fps - The output frame rate.
 * @returns The grid frame window.
 * @throws {RangeError} When an output frame's time lies outside the clip's grid.
 */
export function transitionSourceWindow(grid: { fps: FrameRate; frameCount: number }, clip: TransitionClipPlace, output: FrameWindow, fps: FrameRate): FrameWindow {
  return { start: gridFrameCovering(grid, transitionSlotTime(clip, output.start, fps)), end: gridFrameCovering(grid, transitionSlotTime(clip, output.end - 1, fps)) + 1 };
}
