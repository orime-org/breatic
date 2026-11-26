// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Frame numbers and seconds on a selected version's grid in the browser (inner#1306 frames-split design §4.3 "browser frame numbers and frame seeks",
 * §7.16): the current frame is the last requestVideoFrameCallback mediaTime times fps, rounded; every jump to a frame seeks its
 * midpoint (i + 0.5) / fps. A grid's frame i starts at i / fps and the grid ends at frameCount / fps.
 */

import type { FrameRate } from '@breatic/shared';

/** The grid facts the browser reads: fps and frame count (P.display). */
export interface BrowserFrameGrid { fps: FrameRate; frameCount: number }

/** One grid frame in seconds: its number, start and end. */
export interface GridFrameSeconds { frameIndex: number; pts: number; displayEnd: number }

/**
 * The seconds a jump to frame i seeks: the frame's midpoint (i + 0.5) / fps.
 * @param index - The grid frame number.
 * @param fps - The grid frame rate.
 * @returns The midpoint in seconds.
 * @throws {never} Never.
 */
export function frameMidpointSeconds(index: number, fps: FrameRate): number {
  return (2 * index + 1) * fps.denominator / (2 * fps.numerator);
}

/**
 * The grid frame a presented mediaTime shows: round(mediaTime × fps), held to [0, frameCount − 1]; never from `currentTime`.
 * @param mediaTime - The last frame callback's mediaTime in seconds.
 * @param grid - The selected version's grid.
 * @returns The frame number.
 * @throws {never} Never.
 */
export function frameIndexOfMediaTime(mediaTime: number, grid: BrowserFrameGrid): number {
  const index = Math.round(mediaTime * grid.fps.numerator / grid.fps.denominator);
  return Math.min(grid.frameCount - 1, Math.max(0, Number.isFinite(index) ? index : 0));
}

/**
 * Frame i's start and end in seconds.
 * @param grid - The grid.
 * @param index - The frame number, held to the grid.
 * @returns The frame.
 * @throws {never} Never.
 */
export function gridFrameAt(grid: BrowserFrameGrid, index: number): GridFrameSeconds {
  const frameIndex = Math.min(grid.frameCount - 1, Math.max(0, index));
  return { frameIndex, pts: gridSeconds(grid, frameIndex), displayEnd: gridSeconds(grid, frameIndex + 1) };
}

/**
 * The seconds at grid frame boundary i: i / fps.
 * @param grid - The grid.
 * @param index - The boundary, 0 to frameCount.
 * @returns Seconds.
 * @throws {never} Never.
 */
export function gridSeconds(grid: Pick<BrowserFrameGrid, 'fps'>, index: number): number {
  return index * grid.fps.denominator / grid.fps.numerator;
}

/**
 * The grid's length in seconds: frameCount / fps.
 * @param grid - The grid.
 * @returns Seconds.
 * @throws {never} Never.
 */
export function gridDuration(grid: BrowserFrameGrid): number {
  return gridSeconds(grid, grid.frameCount);
}

/**
 * The grid frame covering a time in seconds (the last one starting at or before it), held to the grid.
 * @param grid - The grid.
 * @param seconds - A time.
 * @returns The frame number.
 * @throws {never} Never.
 */
export function gridFrameCovering(grid: BrowserFrameGrid, seconds: number): number {
  // A frame start written in seconds loses a few ulps; it still names that frame.
  const index = Math.floor(seconds * grid.fps.numerator / grid.fps.denominator + 1e-9);
  return Math.min(grid.frameCount - 1, Math.max(0, Number.isFinite(index) ? index : 0));
}
