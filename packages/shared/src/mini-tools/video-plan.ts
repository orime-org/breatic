// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import type { FrameRate } from "@shared/upload/frame-grid-rate.js";

/** The frame grid a plan is made on (frames-split §4.1): its fps and frame count. */
export interface VideoPlanGrid { fps: FrameRate; frameCount: number }
/** The first, last or current frame; the current one is the player's grid frame number (§4.3). */
export interface VideoFrameRequest { mode: "first" | "last" | "current"; frameIndex?: number }
/** One frame output: a grid frame number, no seconds (§10.8). */
export interface VideoFrameOutput { outputIndex: number; frameIndex: number }
/** One split output: a grid frame range [start, end). */
export interface VideoSplitOutput { outputIndex: number; start: number; end: number }

const frameCount = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const gridSchema = z.object({ fps: z.object({ numerator: z.number().int().positive(), denominator: z.number().int().positive() }), frameCount });
const frameNumber = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// The first, last or current frame (frames-split §10.6: the interval mode is removed).
const frameRequestSchema = z.strictObject({
  mode: z.enum(["first", "last", "current"]),
  frameIndex: frameNumber.optional(),
}).superRefine((request, ctx) => {
  if (request.mode === "current" && request.frameIndex === undefined) ctx.addIssue({ code: "custom", path: ["frameIndex"], message: "Current frame selection requires its grid frame" });
});

/**
 * Plans the frame output on the grid (§10.7 frame extraction row): first is frame 0, last is frameCount − 1, current is the player's
 * grid frame; one output each.
 * @param source - The selected P's grid.
 * @param request - The selected frame mode and, for the current frame, its grid frame number.
 * @param maxOutputs - Optional caller-configured admission ceiling, validated; one output always fits it.
 * @returns The frame output with its stable index.
 * @throws {z.ZodError} When the grid, selection or ceiling is invalid.
 * @throws {RangeError} When the current frame lies outside the grid.
 */
export function planVideoFrames(source: VideoPlanGrid, request: VideoFrameRequest, maxOutputs?: number): VideoFrameOutput[] {
  if (maxOutputs !== undefined) z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(maxOutputs);
  const grid = gridSchema.parse(source);
  const selection = frameRequestSchema.parse(request);
  const frameIndex = selection.mode === "first" ? 0 : selection.mode === "last" ? grid.frameCount - 1 : selection.frameIndex!;
  if (frameIndex >= grid.frameCount) throw new RangeError("The current frame lies outside the grid");
  return [{ outputIndex: 0, frameIndex }];
}

/**
 * Plans the split on the grid (§10.7 split row): cuts are grid frames; 0 and frameCount are dropped, duplicates removed and
 * the rest sorted, giving N + 1 ranges [k0, k1) with the last ending at frameCount.
 * @param source - The selected P's grid.
 * @param cuts - The cut frames, manual or scene-detected, already snapped to grid frames.
 * @returns N plus one ranges for N distinct inner cuts.
 * @throws {z.ZodError} When the grid or a cut is not a non-negative integer.
 * @throws {RangeError} When a cut lies beyond frameCount.
 */
export function planVideoSplit(source: VideoPlanGrid, cuts: readonly number[]): VideoSplitOutput[] {
  const grid = gridSchema.parse(source);
  const requested = z.array(frameNumber).parse(cuts);
  if (requested.some((cut) => cut > grid.frameCount)) throw new RangeError("Split cut lies beyond the grid");
  const inner = [...new Set(requested.filter((cut) => cut > 0 && cut < grid.frameCount))].sort((a, b) => a - b);
  const boundaries = [0, ...inner, grid.frameCount];
  return boundaries.slice(0, -1).map((start, outputIndex) => ({ outputIndex, start, end: boundaries[outputIndex + 1]! }));
}

/**
 * Groups a complete ordered output plan by the caller's per-job capacity.
 * @param outputs - Every planned output, retaining its global identity.
 * @param chunkSize - The existing container's configured capacity.
 * @returns Ordered chunks whose concatenation is the complete output sequence.
 * @throws {z.ZodError} When the per-job capacity is invalid.
 */
export function chunkVideoOutputs<T>(outputs: readonly T[], chunkSize: number): T[][] {
  const capacity = z.number().int().positive().parse(chunkSize);
  return Array.from({ length: Math.ceil(outputs.length / capacity) }, (_, index) => outputs.slice(index * capacity, (index + 1) * capacity));
}
