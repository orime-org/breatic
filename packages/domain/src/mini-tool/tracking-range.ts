// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The checks an erase selection passes both when it is tracked and when it is erased (inner#1306 execution design §10.2,
 * §10.4): an opaque source, the anchor inside the range, and the range's model grid within the eraser's seconds; and the
 * encoded length of each tracking clip, which the tracker is priced by.
 */
import { AppError } from "@breatic/core";
import { t, type VideoPresentationLedger } from "@breatic/shared";
import {
  anchorInTrackingRange, gridSecondsAllowed, modelGrid, presentationFrameAt, presentationFramesIn, type ModelGrid, type TrackingAnchor, type TrackingClips,
  type TrackingTimeRange, type VideoPresentationTable,
} from "@breatic/shared/mini-tools";

/** The eraser limits a range is checked against. */
export interface EraseModelLimits { min_seconds: number; max_seconds: number; max_grid_fps: number }

/**
 * Refuse a source that presents with transparency (§10.4 transparent source row: neither Bria nor VACE takes alpha).
 * @param ledger - The selected tool input's full ledger.
 * @throws {AppError} `transparentSource` when it does.
 */
export function assertOpaqueSource(ledger: VideoPresentationLedger): void {
  if (ledger.plan.policy.emptyFill === "transparent") throw new AppError(400, t("server.mini_tool.transparentSource"));
}

/**
 * The range's presentation frames and the model grid over them, with the anchor inside the range and the grid's seconds
 * within the eraser's (§10.2 anchor rule, §10.4 model grid and duration rows).
 * @param table - The presentation table.
 * @param range - The range in seconds.
 * @param anchor - The anchor.
 * @param model - The eraser limits.
 * @returns The first frame, the count and the grid.
 * @throws {AppError} `anchorOutsideRange` or `eraseRange` when a check refuses it.
 */
export function eraseRangeGrid(table: VideoPresentationTable, range: TrackingTimeRange, anchor: TrackingAnchor, model: EraseModelLimits): { first: number; count: number; grid: ModelGrid } {
  if (!anchorInTrackingRange(range, anchor)) throw new AppError(400, t("server.mini_tool.anchorOutsideRange"));
  const { first, count } = presentationFramesIn(table, range);
  const refused = new AppError(400, t("server.mini_tool.eraseRange", { min: model.min_seconds, max: model.max_seconds }));
  if (count === 0) throw refused;
  const grid = modelGrid(Array.from({ length: count }, (_unused, at) => {
    const frame = presentationFrameAt(table, first + at);
    return { start: frame.pts, end: frame.displayEnd };
  }), model.max_grid_fps);
  if (!gridSecondsAllowed(grid, { minSeconds: model.min_seconds, maxSeconds: model.max_seconds })) throw refused;
  return { first, count, grid };
}

/**
 * Each tracking clip's encoded length in seconds, forward first (§10.2; §10.3 estimate).
 * @param table - The presentation table.
 * @param clips - The clips.
 * @returns The seconds.
 * @throws {RangeError} When a clip lies outside the table.
 */
export function trackingClipSeconds(table: VideoPresentationTable, clips: TrackingClips): number[] {
  return [clips.forward, clips.reverse].flatMap((clip) => clip === null ? [] : [presentationFrameAt(table, clip.end - 1).displayEnd - presentationFrameAt(table, clip.start).pts]);
}
