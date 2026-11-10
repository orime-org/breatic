// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { gridSecondsAllowed, modelGrid, type ModelGrid } from "@shared/mini-tools/model-grid.js";
import { presentationFrameAt, presentationFramesIn } from "@shared/mini-tools/video-presentation-table.js";
import type { VideoPresentationTable } from "@shared/mini-tools/video-presentation-projection.js";

/** A range of presentation frame ordinals, [start, end). */
export interface FrameRange { start: number; end: number }

/** A range of presentation seconds, [start, end). */
export interface TrackingTimeRange { start: number; end: number }

/** An anchor frame: its presentation ordinal and time. */
export interface TrackingAnchor { frameIndex: number; pts: number }

/** The one or two clips a range is tracked on: forward from the anchor, and the frames up to the anchor reversed. */
export interface TrackingClips { forward: FrameRange | null; reverse: FrameRange | null }

/**
 * The clips a range anchored at `anchor` is tracked on (execution design §10.2): the hosted tracker takes its prompt on frame
 * 0 only, so it tracks [anchor, end) forward, and, when the anchor is past the start, [start, anchor] played backwards.
 * @param range - The range, [start, end).
 * @param anchor - The anchor's ordinal inside the range.
 * @returns The clips; the reversed one lists its frames in source order.
 * @throws {RangeError} When the anchor lies outside the range.
 */
export function trackingClips(range: FrameRange, anchor: number): TrackingClips {
  if (!Number.isInteger(anchor) || anchor < range.start || anchor >= range.end) throw new RangeError("The anchor lies outside the tracking range");
  const forward = anchor < range.end - 1 || anchor === range.start ? { start: anchor, end: range.end } : null;
  const reverse = anchor > range.start ? { start: range.start, end: anchor + 1 } : null;
  return { forward, reverse };
}

/**
 * The prepare_model_input jobs a tracking clip is prepared in (execution design §10.2): a forward clip in one job; a
 * reversed clip, whose reverse filter holds every decoded frame of its window 8-bit 4:2:0 at the prepared size, in chunks
 * of at most the frames `reverseBufferBytes` holds, in source order, which a stitch then joins latest chunk first.
 * @param clip - The clip, [start, end).
 * @param order - Its order.
 * @param picture - The prepared picture's size.
 * @param picture.width - Its width.
 * @param picture.height - Its height.
 * @param reverseBufferBytes - The bytes one reversed job may hold (`encoding.reverse_buffer_bytes`).
 * @returns The jobs' windows: one for a clip prepared whole, several for a chunked reversed one.
 * @throws {never} Never.
 */
export function clipJobWindows(clip: FrameRange, order: "forward" | "reverse", picture: { width: number; height: number }, reverseBufferBytes: number): FrameRange[] {
  const most = Math.max(1, Math.floor(reverseBufferBytes / (picture.width * picture.height * 1.5)));
  if (order === "forward" || clip.end - clip.start <= most) return [clip];
  const windows: FrameRange[] = [];
  for (let start = clip.start; start < clip.end; start += most) windows.push({ start, end: Math.min(clip.end, start + most) });
  return windows;
}

/**
 * Whether an erase anchor lies inside its tracking range (execution design §10.2): range.start ≤ anchor.pts < range.end.
 * @param range - The range in presentation seconds.
 * @param anchor - The anchor; its presentation time decides.
 * @returns True inside.
 * @throws {never} Never.
 */
export function anchorInTrackingRange(range: TrackingTimeRange, anchor: TrackingAnchor): boolean {
  return anchor.pts >= range.start && anchor.pts < range.end;
}

/** The eraser limits an erase range is checked against (config `executions."video.erase".model`). */
export interface EraseRangeLimits { minSeconds: number; maxSeconds: number; maxGridFps: number }

/** Why an erase selection is refused: its anchor lies outside the range, or the range's model grid lies outside the eraser's seconds. */
export type EraseRangeRefusal = "anchor" | "range";

/**
 * The one check an erase selection passes both when it is tracked and when it is erased, in the panel and at admission
 * (execution design §10.2 anchor rule, §10.4 model grid and duration rows): the anchor inside the range, then the range's
 * model grid within the eraser's seconds.
 * @param table - The presentation table.
 * @param range - The range in presentation seconds.
 * @param anchor - The anchor.
 * @param limits - The eraser limits.
 * @returns The refusal, or the range's first frame, frame count and model grid.
 * @throws {RangeError} When the table cannot be read.
 */
export function eraseRangeCheck(table: VideoPresentationTable, range: TrackingTimeRange, anchor: TrackingAnchor, limits: EraseRangeLimits):
  { refusal: EraseRangeRefusal } | { refusal: null; first: number; count: number; grid: ModelGrid } {
  if (!anchorInTrackingRange(range, anchor)) return { refusal: "anchor" };
  const { first, count } = presentationFramesIn(table, range);
  if (count === 0) return { refusal: "range" };
  const grid = modelGrid(Array.from({ length: count }, (_unused, at) => {
    const frame = presentationFrameAt(table, first + at);
    return { start: frame.pts, end: frame.displayEnd };
  }), limits.maxGridFps);
  return gridSecondsAllowed(grid, limits) ? { refusal: null, first, count, grid } : { refusal: "range" };
}
