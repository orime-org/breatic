// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { z } from "zod";
import { miniToolAnalysisInputSchema, type MiniToolAnalysisKind } from "@shared/mini-tools/analysis-input.js";
import { canonicalMiniToolValue } from "@shared/mini-tools/canonical-value.js";
import { videoToolAnalysisRefSchema } from "@shared/mini-tools/video-draft.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
// Results are on the grid (frames-split §10.12 analysis-record.ts row): grid frame numbers at the grid fps.
const fpsSchema = z.strictObject({ numerator: z.number().int().positive(), denominator: z.number().int().positive() });

export const miniToolSourceBindingSchema = z.strictObject({
  assetId: z.string().uuid(), contentHash: hashSchema, canonicalURL: z.string().url(),
  kind: z.literal("video"),
  mediaInfo: z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive(), duration: z.number().positive(), mimeType: z.string().min(1) }),
});

const identityShape = {
  schemaVersion: z.literal(1), draftId: z.string().uuid(), revision: z.string().uuid(),
  analysisRunId: z.string().uuid(), acceptedAt: z.iso.datetime({ precision: 6 }),
  binding: miniToolSourceBindingSchema, analysisInput: miniToolAnalysisInputSchema,
  inputFingerprint: hashSchema,
};

/** The owned result format of each analysis; no provider result shape is stored. */
export const miniToolAnalysisResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...identityShape, kind: z.literal("scene_cuts"), fps: fpsSchema, frameCount: z.number().int().positive(), cuts: z.array(z.strictObject({ frameIndex: z.number().int().nonnegative(), detectionScore: z.number() })) }),
]).superRefine((result, ctx) => {
  if (result.analysisInput.kind !== result.kind) ctx.addIssue({ code: "custom", path: ["analysisInput", "kind"], message: "Analysis kind does not match frozen input" });
  if (result.binding.canonicalURL !== result.analysisInput.sourceURL) ctx.addIssue({ code: "custom", path: ["analysisInput", "sourceURL"], message: "Frozen source differs from registered binding" });
  if (result.cuts.some((cut) => cut.frameIndex >= result.frameCount)) ctx.addIssue({ code: "custom", path: ["cuts"], message: "Cut index lies outside the source frame set" });
});

/** Common read contract used by acceptance, refresh and collaborator responses. */
export const miniToolAnalysisRecordSchema = z.strictObject({
  ...identityShape,
  kind: z.enum(["scene_cuts"]),
  // A cancelled analysis is no failure (frames-split §7.19): it has its own state and no error.
  status: z.enum(["pending", "running", "completed", "failed", "cancelled"]),
  result: miniToolAnalysisResultSchema.nullable(),
  error: z.record(z.string(), z.json()).nullable(),
  usage: z.array(z.record(z.string(), z.json())),
  artifactUnavailable: z.boolean(),
}).superRefine((record, ctx) => {
  if (record.kind !== record.analysisInput.kind) ctx.addIssue({ code: "custom", path: ["analysisInput", "kind"], message: "Analysis kind does not match frozen input" });
  if (record.binding.canonicalURL !== record.analysisInput.sourceURL) ctx.addIssue({ code: "custom", path: ["analysisInput", "sourceURL"], message: "Frozen source differs from registered binding" });
  if (record.status === "completed" && record.result === null) ctx.addIssue({ code: "custom", path: ["result"], message: "Completed analysis requires a typed result" });
  if ((record.status === "pending" || record.status === "running") && record.result !== null) ctx.addIssue({ code: "custom", path: ["result"], message: "Unfinished analysis cannot carry a successful result" });
  if ((record.status === "failed") !== (record.error !== null)) ctx.addIssue({ code: "custom", path: ["error"], message: "Failure requires an error; other states cannot carry one" });
  if (record.result === null) return;
  for (const field of [...Object.keys(identityShape), "kind"] as (keyof typeof identityShape | "kind")[]) {
    if (canonicalMiniToolValue(record[field]) !== canonicalMiniToolValue(record.result[field])) ctx.addIssue({ code: "custom", path: ["result", field], message: "Result identity differs from accepted analysis" });
  }
});

export type MiniToolAnalysisRecord = z.infer<typeof miniToolAnalysisRecordSchema>;
export type MiniToolAnalysisResult = z.infer<typeof miniToolAnalysisResultSchema>;
export type MiniToolSourceBinding = z.infer<typeof miniToolSourceBindingSchema>;

/** Selects the newest progress and independently the newest reusable success. */
export interface MiniToolAnalysisSelection {
  latestAccepted: MiniToolAnalysisRecord | null;
  latestSuccessful: MiniToolAnalysisRecord | null;
}

/**
 * Compares fixed-width UTC microseconds before the deterministic run tie-break.
 * @param record - A candidate record.
 * @param held - The currently selected record.
 * @returns Whether the candidate is newer.
 */
function newer(record: MiniToolAnalysisRecord, held: MiniToolAnalysisRecord | null): boolean {
  return held === null || record.acceptedAt > held.acceptedAt || (record.acceptedAt === held.acceptedAt && record.analysisRunId > held.analysisRunId);
}

/**
 * Returns stable selections for the current draft dependencies in any response order.
 * @param records - Received records, validated before selection.
 * @param query - The current draft and dependency identity.
 * @param query.draftId - The draft being edited.
 * @param query.kind - The requested analysis kind.
 * @param query.inputFingerprint - Its dependency fingerprint.
 * @param query.references - Local references rebound by an authorized same-project copy.
 * @returns Independent progress and reusable-result selections.
 */
export function selectMiniToolAnalyses(
  records: readonly unknown[],
  query: { draftId: string; kind: MiniToolAnalysisKind; inputFingerprint: string; references?: readonly unknown[] },
): MiniToolAnalysisSelection {
  const selection: MiniToolAnalysisSelection = { latestAccepted: null, latestSuccessful: null };
  const referencedRuns = new Set<string>();
  for (const value of query.references ?? []) {
    const reference = videoToolAnalysisRefSchema.safeParse(value);
    if (reference.success && reference.data.draftId === query.draftId && reference.data.kind === query.kind && reference.data.inputFingerprint === query.inputFingerprint) {
      referencedRuns.add(reference.data.analysisRunId);
    }
  }
  for (const value of records) {
    const parsed = miniToolAnalysisRecordSchema.safeParse(value);
    if (!parsed.success) continue;
    const record = parsed.data;
    if ((record.draftId !== query.draftId && !referencedRuns.has(record.analysisRunId)) || record.kind !== query.kind || record.inputFingerprint !== query.inputFingerprint) continue;
    if (newer(record, selection.latestAccepted)) selection.latestAccepted = record;
    if (record.status === "completed" && !record.artifactUnavailable && newer(record, selection.latestSuccessful)) selection.latestSuccessful = record;
  }
  return selection;
}
