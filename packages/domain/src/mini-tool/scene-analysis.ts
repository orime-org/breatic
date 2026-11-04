// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { z } from "zod";
import { miniToolAnalysisRecordSchema, miniToolAnalysisResultSchema,
  type MiniToolAnalysisRecord, type MiniToolAnalysisResult } from "@breatic/shared/mini-tools";

// §93 D5-8 (design §7.17 scene_cuts row): the container records each cut by its presentation ordinal; there is no source clock.
const sceneSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal("scene_cuts"),
  cuts: z.array(z.strictObject({ ordinal: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), detectionScore: z.number().finite() })),
});
const clockSchema = z.strictObject({ frameCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), timescale: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
const placedSchema = z.array(z.strictObject({ frameIndex: z.number().int().nonnegative(), pts: z.number().finite().nonnegative() }));

/** The scene detector's owned result on the presentation clock. */
export type MiniToolSceneAnalysisResult = Extract<MiniToolAnalysisResult, { kind: "scene_cuts" }>;

/**
 * Assemble registered scene observations on presentation ordinals (§93 D5-7, D5-8): each cut is the presented frame the
 * worker placed for its ordinal from the frozen ledger, unique, inside the accepted range and the presentation's frames.
 * @param accepted - The original accepted analysis identity and frozen range.
 * @param observations - The registered scene_cuts JSON.
 * @param placed - Each observed cut's presented `{ frameIndex, pts }`, in the observations' order.
 * @param clock - The presentation's frame count and timescale.
 * @param clock.frameCount - Its frame count.
 * @param clock.timescale - Its timescale.
 * @returns Cuts on the presentation clock with the accepted identity intact.
 * @throws {Error} When content, the clock, the range or a placement differs.
 */
export function assembleMiniToolSceneAnalysis(accepted: MiniToolAnalysisRecord, observations: unknown, placed: readonly { frameIndex: number; pts: number }[],
  clock: { frameCount: number; timescale: number }): MiniToolSceneAnalysisResult {
  const original = miniToolAnalysisRecordSchema.parse(accepted);
  const input = original.analysisInput;
  if (original.kind !== "scene_cuts" || input.kind !== "scene_cuts") throw new Error("Scene assembly requires the original scene analysis");
  const scene = sceneSchema.parse(observations);
  const { frameCount, timescale } = clockSchema.parse(clock);
  const frames = placedSchema.parse(placed);
  if (frames.length !== scene.cuts.length || new Set(scene.cuts.map((cut) => cut.ordinal)).size !== scene.cuts.length) {
    throw new Error("Scene cuts must each name one unique placed presentation frame");
  }
  const cuts = scene.cuts.map((cut, index) => {
    const frame = frames[index]!;
    if (frame.frameIndex !== cut.ordinal || cut.ordinal >= frameCount || frame.pts < input.range.start || frame.pts >= input.range.end) {
      throw new Error("Scene cut lies outside the accepted range or is placed on another frame");
    }
    return { frameIndex: cut.ordinal, pts: frame.pts, detectionScore: cut.detectionScore };
  });
  const result: MiniToolSceneAnalysisResult = {
    schemaVersion: 1, kind: "scene_cuts", draftId: original.draftId, revision: original.revision,
    analysisRunId: original.analysisRunId, acceptedAt: original.acceptedAt, binding: original.binding,
    analysisInput: input, inputFingerprint: original.inputFingerprint,
    timeBase: { numerator: 1, denominator: timescale }, frameCount, cuts,
  };
  miniToolAnalysisResultSchema.parse(result);
  return result;
}
