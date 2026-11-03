// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { z } from "zod";
import { canonicalMiniToolValue, miniToolAnalysisRecordSchema, miniToolAnalysisResultSchema,
  type MiniToolAnalysisRecord, type MiniToolAnalysisResult } from "@breatic/shared/mini-tools";

const frameSchema = z.strictObject({ frameIndex: z.number().int().nonnegative(), pts: z.number() });
const clockSchema = z.string().regex(/^\d+\/\d+$/).refine((clock) => clock.split("/").every((part) => Number.isSafeInteger(Number(part)) && Number(part) > 0));
const inspectionSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal("inspect_video"), probe: z.record(z.string(), z.unknown()),
  source: z.strictObject({
    width: z.number().int().positive(), height: z.number().int().positive(), timeBase: clockSchema,
    rotation: z.number(), hasAudio: z.boolean(),
    frameTable: z.strictObject({ frames: z.array(frameSchema).min(1), videoEnd: z.number() }),
  }),
});
const sceneSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal("scene_cuts"), timeBase: clockSchema,
  frameCount: z.number().int().positive(), sourceFrameMapping: z.array(frameSchema),
  cuts: z.array(z.strictObject({ frameIndex: z.number().int().nonnegative(), pts: z.number().nonnegative(), detectionScore: z.number() })),
});

/** The scene detector's owned result on the complete original source clock. */
export type MiniToolSceneAnalysisResult = Extract<MiniToolAnalysisResult, { kind: "scene_cuts" }>;

/**
 * Assemble registered scene observations against the inspected original ledger.
 * @param accepted - The original accepted analysis identity and frozen range.
 * @param inspection - The registered inspect_video JSON.
 * @param observations - The registered scene_cuts JSON.
 * @returns Cuts on the original source clock with the accepted identity intact.
 * @throws {Error} When content, clock, range or source-frame associations differ.
 */
export function assembleMiniToolSceneAnalysis(accepted: MiniToolAnalysisRecord, inspection: unknown, observations: unknown): MiniToolSceneAnalysisResult {
  const original = miniToolAnalysisRecordSchema.parse(accepted);
  const input = original.analysisInput;
  if (original.kind !== "scene_cuts" || input.kind !== "scene_cuts") throw new Error("Scene assembly requires the original scene analysis");
  const { source } = inspectionSchema.parse(inspection);
  const scene = sceneSchema.parse(observations);
  const frames = source.frameTable.frames;
  if (frames.some((frame, index) => frame.frameIndex !== index || (index > 0 && frame.pts < frames[index - 1]!.pts)) ||
    source.frameTable.videoEnd <= frames[frames.length - 1]!.pts) {
    throw new Error("Inspected scene source requires its complete ordered frame ledger and endpoint");
  }
  if (scene.timeBase !== source.timeBase || scene.frameCount !== frames.length) {
    throw new Error("Scene clock or complete frame count differs from its inspected source");
  }
  const mapping = frames.filter((frame) => frame.pts >= input.range.start && frame.pts < input.range.end);
  if (mapping.length === 0 || canonicalMiniToolValue(scene.sourceFrameMapping) !== canonicalMiniToolValue(mapping)) {
    throw new Error("Scene mapping differs from the original range on its source ledger");
  }
  const byIndex = new Map(mapping.map((frame) => [frame.frameIndex, frame.pts]));
  if (new Set(scene.cuts.map((cut) => cut.frameIndex)).size !== scene.cuts.length ||
    scene.cuts.some((cut) => byIndex.get(cut.frameIndex) !== cut.pts)) {
    throw new Error("Scene cuts must uniquely name original mapped source frames and PTS");
  }
  const [numerator, denominator] = source.timeBase.split("/").map(Number);
  const result: MiniToolSceneAnalysisResult = {
    schemaVersion: 1, kind: "scene_cuts", draftId: original.draftId, revision: original.revision,
    analysisRunId: original.analysisRunId, acceptedAt: original.acceptedAt, binding: original.binding,
    analysisInput: input, inputFingerprint: original.inputFingerprint,
    timeBase: { numerator: numerator!, denominator: denominator! }, frameCount: frames.length, cuts: scene.cuts,
  };
  miniToolAnalysisResultSchema.parse(result);
  return result;
}
