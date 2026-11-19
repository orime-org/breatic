// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { miniToolPlanJobRequestSchema, readMiniToolPlanJobReport,
  type MiniToolPlanJobReport, type MiniToolPlanJobRequest, type MiniToolPlanPixelRect, type StudioAssetEntity } from "@breatic/shared";
import { canonicalMiniToolValue, miniToolAnalysisRecordSchema, miniToolAnalysisResultSchema,
  type MiniToolAnalysisArtifact, type MiniToolAnalysisRecord, type MiniToolAnalysisResult } from "@breatic/shared/mini-tools";

const pixelCoordinate = z.number().int().nonnegative();
const pixelSize = z.number().int().positive();
const displayPeopleSchema = z.strictObject({
  // §93 D5-8: the recipe on an entry has no anchor, so the container echoes none; the accepted anchor is the result's.
  schemaVersion: z.literal(1), kind: z.literal("people"), coordinateSpace: z.literal("display"), width: pixelSize, height: pixelSize,
  candidates: z.array(z.strictObject({
    detectionIndex: pixelCoordinate,
    faceBox: miniToolAnalysisResultSchema.options[0].shape.people.element.shape.faceBox,
    pixelCrop: z.strictObject({ x: pixelCoordinate, y: pixelCoordinate, width: pixelSize, height: pixelSize }),
  })),
}).superRefine((people, ctx) => {
  if (new Set(people.candidates.map((candidate) => candidate.detectionIndex)).size !== people.candidates.length) {
    ctx.addIssue({ code: "custom", message: "Display candidate indices must be unique" });
  }
  for (const { pixelCrop } of people.candidates) {
    if (pixelCrop.x + pixelCrop.width > people.width || pixelCrop.y + pixelCrop.height > people.height) {
      ctx.addIssue({ code: "custom", message: "Saved candidate pixels lie outside the display frame" });
    }
  }
});

/** The owned people result preserves the accepted identity and canonical thumbnails. */
export type MiniToolPeopleAnalysisResult = Extract<MiniToolAnalysisResult, { kind: "people" }>;

/** Display candidates retain their detector indices and saved integer pixel regions. */
export interface MiniToolDisplayPeople {
  schemaVersion: 1;
  kind: "people";
  coordinateSpace: "display";
  width: number;
  height: number;
  candidates: { detectionIndex: number; faceBox: MiniToolPeopleAnalysisResult["people"][number]["faceBox"]; pixelCrop: MiniToolPlanPixelRect }[];
}

/** A task-owned original plan, actual report and canonical registered output rows. */
export interface MiniToolRegisteredAnalysisJob {
  request: MiniToolPlanJobRequest;
  report: MiniToolPlanJobReport;
  assets: { outputIndex: number; asset: StudioAssetEntity }[];
}

/**
 * Read display candidates of the accepted people analysis, measured in its people recipe's target geometry (§93 D5-8).
 * @param accepted - The original SQL accepted analysis.
 * @param observations - Its registered display detector JSON.
 * @param target - The people recipe's display target, when the caller holds it.
 * @param target.width - Its width.
 * @param target.height - Its height.
 * @returns Validated candidates in the display geometry.
 * @throws {Error} When content, geometry or candidate identities are invalid, or the geometry is not the target's.
 */
export function readMiniToolDisplayPeople(accepted: MiniToolAnalysisRecord, observations: unknown, target?: { width: number; height: number }): MiniToolDisplayPeople {
  const original = miniToolAnalysisRecordSchema.parse(accepted);
  if (original.kind !== "people" || original.analysisInput.kind !== "people") throw new Error("Display candidates require the original people analysis");
  const people = displayPeopleSchema.parse(observations);
  if (target !== undefined && (people.width !== target.width || people.height !== target.height)) {
    throw new Error("Display candidates were not measured in the people recipe's target geometry");
  }
  return people;
}

/**
 * Assemble canonical thumbnails from the original task-owned job collection.
 * @param accepted - The original SQL accepted analysis.
 * @param sourceKey - The SQL frozen source key mapped by the original source alias.
 * @param observations - The original registered display candidates.
 * @param jobs - Original thumbnail plans, reports and registered rows from the owning task.
 * @returns The complete run-scoped people result with canonical image references.
 * @throws {Error} When candidates, original recipes, reports or registered rows differ.
 */
export function assembleMiniToolPeopleAnalysis(
  accepted: MiniToolAnalysisRecord, sourceKey: string, observations: unknown, jobs: readonly MiniToolRegisteredAnalysisJob[],
): MiniToolPeopleAnalysisResult {
  const original = miniToolAnalysisRecordSchema.parse(accepted);
  const people = readMiniToolDisplayPeople(original, observations);
  if (original.analysisInput.kind !== "people") throw new Error("People assembly requires the original people analysis");
  const { anchor } = original.analysisInput;
  const candidates = new Map(people.candidates.map((candidate) => [candidate.detectionIndex, candidate]));
  const references = new Map<number, MiniToolAnalysisArtifact>();
  for (const job of jobs) {
    const request = miniToolPlanJobRequestSchema.parse(job.request);
    const report = readMiniToolPlanJobReport(request, job.report);
    if (report.state !== "done") throw new Error("People thumbnails require a completed original plan");
    if (!request.inputs.some((input) => input.inputId === original.binding.assetId && input.storageKey === sourceKey)) {
      throw new Error("People thumbnails differ from the original source binding");
    }
    const assets = new Map(job.assets.map((entry) => [entry.outputIndex, entry.asset]));
    if (assets.size !== job.assets.length || assets.size !== request.outputs.length ||
      job.assets.some((entry) => !request.outputs.some((output) => output.outputIndex === entry.outputIndex))) {
      throw new Error("People thumbnails require the exact unique registered output set");
    }
    const measurements = new Map(report.outputs.map((output) => [output.outputIndex, output]));
    for (const output of request.outputs) {
      const candidate = candidates.get(output.outputIndex);
      const recipe = output.recipe;
      // §93 D5-7 (frames-split §7.16): each thumbnail is the anchor's grid frame, cropped in the display geometry.
      if (candidate === undefined || references.has(output.outputIndex) || output.contentType !== "image/png" ||
        recipe.kind !== "frame" || recipe.inputId !== original.binding.assetId ||
        recipe.frameIndex !== anchor.frameIndex || recipe.crop === undefined ||
        recipe.crop.sourceWidth !== people.width || recipe.crop.sourceHeight !== people.height ||
        canonicalMiniToolValue(recipe.crop.rect) !== canonicalMiniToolValue(candidate.pixelCrop)) {
        throw new Error("People thumbnail recipe differs from its original display candidate");
      }
      const measured = measurements.get(output.outputIndex);
      const asset = assets.get(output.outputIndex);
      if (measured === undefined || measured.width !== candidate.pixelCrop.width || measured.height !== candidate.pixelCrop.height ||
        asset === undefined || asset.deletedAt !== null || asset.kind !== "image" ||
        asset.contentHash !== measured.sha256 || asset.sizeBytes !== measured.sizeBytes) {
        throw new Error("People thumbnail differs from its measured registered image");
      }
      references.set(output.outputIndex, {
        role: "thumbnail", assetId: asset.id, canonicalURL: asset.fileUrl, contentHash: asset.contentHash,
        kind: asset.kind, mimeType: asset.mimeType, size: asset.sizeBytes, frameMetadata: null,
      });
    }
  }
  if (references.size !== candidates.size) throw new Error("People thumbnails are incomplete for the original candidate set");
  const result: MiniToolPeopleAnalysisResult = {
    schemaVersion: 1, kind: "people", draftId: original.draftId, revision: original.revision,
    analysisRunId: original.analysisRunId, acceptedAt: original.acceptedAt, binding: original.binding,
    analysisInput: original.analysisInput, inputFingerprint: original.inputFingerprint, anchor,
    people: people.candidates.map((candidate) => ({ personId: `person:${original.analysisRunId}:${candidate.detectionIndex}`,
      faceBox: candidate.faceBox, artifactRefs: [references.get(candidate.detectionIndex)!] })),
  };
  miniToolAnalysisResultSchema.parse(result);
  return result;
}
