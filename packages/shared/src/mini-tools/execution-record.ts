// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { miniToolSourceBindingSchema, type MiniToolSourceBinding } from "@shared/mini-tools/analysis-record.js";
import { miniToolExecutionRecipeSchema, type MiniToolPlannedRequest } from "@shared/mini-tools/planned-request-schema.js";

/** Public registered cover facts, independent from provider presentation derivatives. */
export interface MiniToolExecutionCover {
  assetId: string; canonicalURL: string; kind: "image"; mimeType: string; size: number;
  contentHash: string; width: number | null; height: number | null;
}
/** Public canonical media identity and measured, nullable metadata. */
export interface MiniToolExecutionRegistered {
  status: "registered"; assetId: string; canonicalURL: string;
  kind: "image" | "video" | "audio" | "document" | "file";
  mimeType: string; size: number; contentHash: string;
  width: number | null; height: number | null; duration: number | null;
  cover: MiniToolExecutionCover | null;
}
/** One stable planned slot: null until the run ends, then registered for every output or failed for every output. */
export interface MiniToolExecutionOutput {
  outputIndex: number; nodeId: string; recipe: MiniToolPlannedRequest["outputs"][number]["recipe"];
  result: MiniToolExecutionRegistered | { status: "failed"; error: Record<string, z.infer<ReturnType<typeof z.json>>> } | null;
}
/** A deliberately narrow public copy of the existing step-owned consumption fact. */
export interface MiniToolExecutionUsage {
  consumptionKey: string; state: "pending" | "known" | "recorded"; chargeTo: "user" | "platform";
  costUsd: number | null; credits: number | null;
}
/** Project-readable execution state; no storage capability or provider response is public. */
export interface MiniToolExecutionRecord {
  schemaVersion: 1; runId: string; status: "pending" | "running" | "completed" | "failed" | "cancelled";
  planFingerprint: string; resultVersion: number; sourceBindings: MiniToolSourceBinding[];
  outputs: MiniToolExecutionOutput[]; usage: MiniToolExecutionUsage[];
  billingState: "idle" | "waiting" | "checking" | "settled";
  error: Record<string, z.infer<ReturnType<typeof z.json>>> | null;
  /** When the run reached its commit point: every output reported, registration under way (frames-split §7.19). */
  commitPoint?: string;
}

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const jsonObject = z.record(z.string(), z.json());
const dimension = z.number().int().positive().nullable();
const assetFields = {
  assetId: z.uuid(), canonicalURL: z.url(), mimeType: z.string().min(1),
  size: z.number().int().nonnegative(), contentHash: hashSchema, width: dimension, height: dimension,
};
const registeredSchema = z.strictObject({
  ...assetFields, status: z.literal("registered"), kind: z.enum(["image", "video", "audio", "document", "file"]),
  duration: z.number().nonnegative().nullable(), cover: z.strictObject({ ...assetFields, kind: z.literal("image") }).nullable(),
});

/** Complete stable slot facts; private provider and storage capabilities are rejected. */
export const miniToolExecutionOutputSchema = z.strictObject({
  outputIndex: z.number().int().nonnegative(), nodeId: z.uuid(),
  recipe: miniToolExecutionRecipeSchema,
  result: z.discriminatedUnion("status", [registeredSchema, z.strictObject({ status: z.literal("failed"), error: jsonObject })]).nullable(),
});

/** Actual consumption preserves its original amount's confirmation and recording state. */
export const miniToolExecutionUsageSchema = z.strictObject({
  consumptionKey: hashSchema, state: z.enum(["pending", "known", "recorded"]), chargeTo: z.enum(["user", "platform"]),
  costUsd: z.number().nonnegative().nullable(), credits: z.number().nonnegative().nullable(),
}).superRefine((usage, ctx) => {
  const valid = usage.state === "pending" ? usage.costUsd === null && usage.credits === null
    : usage.state === "known" ? usage.costUsd !== null && usage.credits === null
      : usage.costUsd !== null && usage.credits !== null && (usage.chargeTo !== "platform" || usage.credits === 0);
  if (!valid) ctx.addIssue({ code: "custom", message: "Amounts differ from their actual consumption state" });
});

/** Versioned project-readable state, with media completion independent from billing. */
export const miniToolExecutionRecordSchema: z.ZodType<MiniToolExecutionRecord> = z.strictObject({
  schemaVersion: z.literal(1), runId: z.uuid(), status: z.enum(["pending", "running", "completed", "failed", "cancelled"]),
  planFingerprint: hashSchema, resultVersion: z.number().int().nonnegative(),
  sourceBindings: z.array(miniToolSourceBindingSchema).min(1), outputs: z.array(miniToolExecutionOutputSchema).min(1),
  usage: z.array(miniToolExecutionUsageSchema), billingState: z.enum(["idle", "waiting", "checking", "settled"]), error: jsonObject.nullable(),
  commitPoint: z.iso.datetime().optional(),
}).superRefine((record, ctx) => {
  if (new Set(record.outputs.map((output) => output.outputIndex)).size !== record.outputs.length
    || new Set(record.outputs.map((output) => output.nodeId)).size !== record.outputs.length
    || new Set(record.usage.map((usage) => usage.consumptionKey)).size !== record.usage.length) {
    ctx.addIssue({ code: "custom", message: "Output and consumption identities must be unique" });
  }
  if (record.status === "pending" || record.status === "running") {
    // A run registers nothing until its one completed commit (frames-split §7.19), past its commit point included.
    if (record.error !== null || record.outputs.some((output) => output.result !== null)) {
      ctx.addIssue({ code: "custom", message: "Active execution has no media snapshot" });
    }
  } else if (record.status !== "cancelled") {
    if (record.resultVersion === 0 || record.outputs.some((output) => output.result === null)) {
      ctx.addIssue({ code: "custom", message: "Terminal execution requires every planned output" });
    }
    if (record.status === "completed" && (record.error !== null || record.outputs.some((output) => output.result?.status !== "registered"))) {
      ctx.addIssue({ code: "custom", message: "Completed execution requires its canonical registered outputs" });
    }
    if (record.status === "failed" && (record.error === null || record.outputs.some((output) => output.result?.status !== "failed"))) {
      ctx.addIssue({ code: "custom", message: "Failed execution fails every output and retains its original error" });
    }
  }
  if (record.commitPoint !== undefined && record.status !== "running") {
    ctx.addIssue({ code: "custom", message: "Only a running execution carries a commit point" });
  }
});

