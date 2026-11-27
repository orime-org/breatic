// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { z } from "zod";
import type { FrameRate } from "@breatic/shared";
import { miniToolAnalysisRecordSchema, miniToolAnalysisResultSchema,
  type MiniToolAnalysisRecord, type MiniToolAnalysisResult } from "@breatic/shared/mini-tools";

// Design §7.17 scene_cuts row (frames-split §10.12 scene-analysis.ts row): the container records each cut by its grid frame.
const sceneSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal("scene_cuts"),
  cuts: z.array(z.strictObject({ frameIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), detectionScore: z.number().finite() })),
});
const gridSchema = z.strictObject({
  fps: z.strictObject({ numerator: z.number().int().positive(), denominator: z.number().int().positive() }),
  frameCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

/** The scene detector's owned result on the frame grid. */
export type MiniToolSceneAnalysisResult = Extract<MiniToolAnalysisResult, { kind: "scene_cuts" }>;

/**
 * Assemble registered scene observations on grid frames (frames-split §7.16, §10.12): each cut is a unique grid frame inside
 * the accepted range and the grid.
 * @param accepted - The original accepted analysis identity and frozen range.
 * @param observations - The registered scene_cuts JSON.
 * @param grid - The frozen grid's fps and frame count.
 * @param grid.fps - The grid fps.
 * @param grid.frameCount - The grid's frames.
 * @returns Cuts on the grid with the accepted identity intact.
 * @throws {Error} When content, the grid or the range differs.
 */
export function assembleMiniToolSceneAnalysis(accepted: MiniToolAnalysisRecord, observations: unknown, grid: { fps: FrameRate; frameCount: number }): MiniToolSceneAnalysisResult {
  const original = miniToolAnalysisRecordSchema.parse(accepted);
  const input = original.analysisInput;
  if (original.kind !== "scene_cuts" || input.kind !== "scene_cuts") throw new Error("Scene assembly requires the original scene analysis");
  const scene = sceneSchema.parse(observations);
  const { fps, frameCount } = gridSchema.parse(grid);
  if (new Set(scene.cuts.map((cut) => cut.frameIndex)).size !== scene.cuts.length) throw new Error("Scene cuts must each name one unique grid frame");
  for (const cut of scene.cuts) {
    if (cut.frameIndex >= frameCount || cut.frameIndex < input.range.start || cut.frameIndex >= input.range.end) throw new Error("Scene cut lies outside the accepted range");
  }
  const result: MiniToolSceneAnalysisResult = {
    schemaVersion: 1, kind: "scene_cuts", draftId: original.draftId, revision: original.revision,
    analysisRunId: original.analysisRunId, acceptedAt: original.acceptedAt, binding: original.binding,
    analysisInput: input, inputFingerprint: original.inputFingerprint, fps, frameCount, cuts: scene.cuts,
  };
  miniToolAnalysisResultSchema.parse(result);
  return result;
}
