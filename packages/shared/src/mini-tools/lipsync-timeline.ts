// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

// Kept free of zod: the media container maps result frames to source frames with these, and its process loads only our own code.

import type { FrameRate } from "@shared/upload/frame-grid-rate.js";

/** The frame grid a lip-sync step maps through (frames-split §4.1): its fps and frame count. */
export interface LipsyncGrid { fps: FrameRate; frameCount: number }

/** The lip-sync duration modes (execution design §9.2). */
export const VIDEO_TOOL_SYNC_MODES = ["cut_off", "silence", "loop", "bounce", "remap"] as const;

/** The frozen lip-sync timeline: the result duration, the video's presentation duration V and the duration mode. */
export interface LipsyncTimeline { duration: number; videoDuration: number; syncMode: (typeof VIDEO_TOOL_SYNC_MODES)[number] }

/**
 * The source presentation tick s in [0, V] a result tick shows (§9.2, §97 D14-1; execution design paragraph before §9.4),
 * s = V being the last presentation frame, all in whole ticks of the source's clock so every loop and bounce cycle repeats
 * the first exactly: cut_off s = t; silence s = min(t, V); loop s = t mod V; bounce u = t mod 2V, s = u when u <= V else
 * 2V - u, going back while u > V; remap s = floor(t · V / duration).
 * @param timeline - The frozen timeline.
 * @param timescale - The source's clock.
 * @param tick - The result time in whole ticks.
 * @returns The source tick and whether the result moves back through the source there.
 * @throws {never} Never.
 */
export function lipsyncSourceTickAt(timeline: LipsyncTimeline, timescale: number, tick: number): { tick: number; reverse: boolean } {
  const v = Math.round(timeline.videoDuration * timescale);
  switch (timeline.syncMode) {
    case "cut_off": return { tick, reverse: false };
    case "silence": return { tick: Math.min(tick, v), reverse: false };
    case "loop": return { tick: tick % v, reverse: false };
    case "bounce": {
      const u = tick % (2 * v);
      return u <= v ? { tick: u, reverse: false } : { tick: 2 * v - u, reverse: true };
    }
    case "remap": return { tick: Math.floor((tick * v) / Math.round(timeline.duration * timescale)), reverse: false };
  }
}

/**
 * The grid frame result frame k shows: the source grid frame covering the source tick of k · step on the grid's clock
 * (fps.numerator ticks a second, fps.denominator ticks a frame), s = V giving the last frame.
 * @param timeline - The frozen timeline.
 * @param grid - The source's frame grid.
 * @param k - The result frame.
 * @returns The grid frame index.
 * @throws {RangeError} When the grid has no frame.
 */
export function lipsyncSourceFrameAt(timeline: LipsyncTimeline, grid: LipsyncGrid, k: number): number {
  if (grid.frameCount <= 0) throw new RangeError("Expected a presented frame");
  const step = grid.fps.denominator;
  // Whole ticks over one clock divide exactly, so the covering frame is their quotient.
  const tick = lipsyncSourceTickAt(timeline, grid.fps.numerator, k * step).tick;
  return Math.min(grid.frameCount - 1, Math.max(0, Math.floor(tick / step)));
}

/**
 * The bytes of one raw 8-bit 4:2:0 picture as the lip-sync container writes it and admission budgets it: luma, the two
 * chroma planes at half size rounded up and, for a transparent picture, alpha at luma size.
 * @param width - Its width.
 * @param height - Its height.
 * @param alpha - Whether it carries an alpha plane.
 * @returns The bytes.
 * @throws {never} Never.
 */
export function lipsyncPictureBytes(width: number, height: number, alpha: boolean): number {
  return width * height * (alpha ? 2 : 1) + 2 * Math.ceil(width / 2) * Math.ceil(height / 2);
}

/**
 * The source grid frame each result frame shows, on the grid the container writes: frame k at k / fps,
 * `lipsyncResultFrameCount` frames, the last ending at the result duration.
 * @param timeline - The frozen timeline.
 * @param grid - The source's frame grid.
 * @returns One source frame per result frame.
 * @throws {RangeError} When the grid has no frame.
 */
export function lipsyncResultSourceFrames(timeline: LipsyncTimeline, grid: LipsyncGrid): number[] {
  return Array.from({ length: lipsyncResultFrameCount(timeline, grid) }, (_unused, k) => lipsyncSourceFrameAt(timeline, grid, k));
}

/**
 * The result's frames on the source grid: ceil(round(duration · fps.numerator) / fps.denominator).
 * @param timeline - The frozen timeline.
 * @param grid - The source's frame grid.
 * @returns The frame count.
 * @throws {never} Never.
 */
export function lipsyncResultFrameCount(timeline: LipsyncTimeline, grid: LipsyncGrid): number {
  return Math.ceil(Math.round(timeline.duration * grid.fps.numerator) / grid.fps.denominator);
}

/**
 * The source frames a clip crops into its crop file (execution design paragraph before §9.4): its one forward decode
 * passes every frame up to the highest the result shows, so a frame needs keeping when the result shows it again, or first
 * shows it after a later frame, which a variable-frame-rate source's loop or bounce does.
 * @param sources - The source frame of each result frame.
 * @returns The frames, ascending.
 * @throws {never} Never.
 */
export function lipsyncClipCropFrames(sources: readonly number[]): number[] {
  const [seen, kept] = [new Set<number>(), new Set<number>()];
  let highest = -1;
  for (const frame of sources) {
    if (seen.has(frame) || frame < highest) kept.add(frame);
    seen.add(frame);
    highest = Math.max(highest, frame);
  }
  return [...kept].sort((a, b) => a - b);
}

/**
 * The source frames a window of result frames shows (execution design paragraph before §9.4): its half-open
 * [lowest, highest + 1) and whether a later frame lies below an earlier one, which a forward decode cannot serve.
 * @param sources - The source frame of each result frame.
 * @param window - The half-open result frames.
 * @param window.start - The first.
 * @param window.end - The end.
 * @returns The span and whether it goes back.
 * @throws {RangeError} When the window is empty or outside the sources.
 */
export function lipsyncSourceSpan(sources: readonly number[], window: { start: number; end: number }): { start: number; end: number; goesBack: boolean } {
  if (window.end <= window.start || window.start < 0 || window.end > sources.length) throw new RangeError("Expected result frames");
  let [low, high, goesBack] = [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, false];
  for (let k = window.start; k < window.end; k += 1) {
    const frame = sources[k]!;
    if (frame < high) goesBack = true;
    low = Math.min(low, frame);
    high = Math.max(high, frame);
  }
  return { start: low, end: high + 1, goesBack };
}

/**
 * The grid frames a composite chunk shows (execution design paragraph before §9.4): result frames
 * [window.start, window.end) at k / fps map to source grid frames, and the chunk decodes
 * only [lowest, highest + 1) of them. The worker writes the chunk's entries over it and the container indexes its decoded
 * frames from its start, so both read this one function.
 * @param timeline - The frozen timeline.
 * @param grid - The source's frame grid.
 * @param window - The chunk's half-open result frames.
 * @param window.start - The first.
 * @param window.end - The end.
 * @returns The half-open source grid frames.
 * @throws {RangeError} When the grid has no frame or the window is empty.
 */
export function lipsyncChunkSourceWindow(timeline: LipsyncTimeline, grid: LipsyncGrid, window: { start: number; end: number }): { start: number; end: number } {
  if (window.end <= window.start) throw new RangeError("Expected a result frame");
  const sources = Array.from({ length: window.end - window.start }, (_unused, at) => lipsyncSourceFrameAt(timeline, grid, window.start + at));
  const { start, end } = lipsyncSourceSpan(sources, { start: 0, end: sources.length });
  return { start, end };
}
