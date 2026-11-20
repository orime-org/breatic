// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The checks an erase selection passes both when it is tracked and when it is erased (inner#1306 execution design §10.2,
 * §10.4): an opaque source, the anchor inside the range, and the range's model grid within the eraser's seconds; and the
 * encoded length of each tracking clip, which the tracker is priced by.
 */
import { AppError } from "@breatic/core";
import { t, type VideoPresentationVersion } from "@breatic/shared";
import { eraseRangeCheck, type ModelGrid, type TrackingAnchor, type TrackingClips, type TrackingTimeRange } from "@breatic/shared/mini-tools";
import { modelSecondsRange } from "@domain/mini-tool/model-call-admission.js";
import { presentsTransparent } from "@domain/mini-tool/selected-tool-input.js";

/** The eraser limits a range is checked against: its vendor's seconds and the grid ceiling we resample to. */
export interface EraseModelLimits { minSeconds: number; maxSeconds: number; maxGridFps: number }

/**
 * The configured eraser's limits: its seconds from its vendor's provider rejects (execution design §11.5), its grid
 * ceiling from `config/mini-tools.yaml`.
 * @param model - The erase execution's model.
 * @param model.name - Its catalog name.
 * @param model.max_grid_fps - The grid ceiling it is resampled to.
 * @returns The limits, or null when the vendor states no longest call, so erase cannot be offered.
 */
export function eraseModelLimits(model: { name: string; max_grid_fps: number }): EraseModelLimits | null {
  const { minSeconds, maxSeconds } = modelSecondsRange(model.name);
  return maxSeconds === null ? null : { minSeconds, maxSeconds, maxGridFps: model.max_grid_fps };
}

/**
 * Refuse a source that presents with transparency (§10.4 transparent source row: neither Bria nor VACE takes alpha).
 * @param version - The selected version.
 * @throws {AppError} `transparentSource` when it does.
 */
export function assertOpaqueSource(version: VideoPresentationVersion): void {
  if (presentsTransparent(version)) throw new AppError(400, t("server.mini_tool.transparentSource"));
}

/**
 * The range's grid frames and the model grid over them, refused as the panel refuses them (`eraseRangeCheck`).
 * @param display - The selected version's display grid.
 * @param range - The range of grid frames.
 * @param anchor - The anchor.
 * @param model - The eraser limits.
 * @returns The first frame, the count and the grid.
 * @throws {AppError} `anchorOutsideRange` or `eraseRange` when the check refuses it.
 */
export function eraseRangeGrid(display: VideoPresentationVersion["display"], range: TrackingTimeRange, anchor: TrackingAnchor, model: EraseModelLimits): { first: number; count: number; grid: ModelGrid } {
  const checked = eraseRangeCheck({ fps: display.fps, frameCount: display.frameCount }, range, anchor, model);
  if (checked.refusal !== null) {
    throw new AppError(400, checked.refusal === "anchor" ? t("server.mini_tool.anchorOutsideRange") : t("server.mini_tool.eraseRange", { min: model.minSeconds, max: model.maxSeconds }));
  }
  return { first: checked.first, count: checked.count, grid: checked.grid };
}

/**
 * Each tracking clip's encoded length in grid seconds, forward first (§10.2; §10.3 estimate): its frames over the grid fps.
 * @param display - The selected version's display grid.
 * @param clips - The clips.
 * @returns The seconds.
 * @throws {never} Never.
 */
export function trackingClipSeconds(display: VideoPresentationVersion["display"], clips: TrackingClips): number[] {
  return [clips.forward, clips.reverse].flatMap((clip) => clip === null ? [] : [((clip.end - clip.start) * display.fps.denominator) / display.fps.numerator]);
}
