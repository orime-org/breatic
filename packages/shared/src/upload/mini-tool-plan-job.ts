// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";
import { miniToolAnalysisInputSchema, miniToolAnchorSchema } from "@shared/mini-tools/analysis-input.js";
import { canonicalMiniToolValue } from "@shared/mini-tools/canonical-value.js";
import { CONTAINER_FAILURES } from "@shared/mini-tools/types.js";
import { ingestMeasurements } from "@shared/upload/ingest-client.js";
import { MINI_TOOL_JOB_MAX_OUTPUTS } from "@shared/upload/mini-tool-job.js";
import type { MiniToolPlanRecipe } from "@shared/upload/mini-tool-plan-types.js";

export type { MiniToolPlanRecipe } from "@shared/upload/mini-tool-plan-types.js";

const inputId = z.uuid();
const storageKey = z.string().min(1).max(500);
const index = z.number().int().nonnegative();
const range = z.strictObject({ start: z.number().nonnegative(), end: z.number().positive() })
  .refine((value) => value.end > value.start);
const profile = miniToolAnalysisInputSchema.options[0].shape.profile;

/** Output and diagnostic byte ceilings frozen from the task's runtime configuration. */
export const miniToolPlanLimitsSchema = z.strictObject({
  probeStdoutBytes: z.number().int().positive(),
  analysisStdoutBytes: z.number().int().positive(),
  stderrTailBytes: z.number().int().positive(),
});

/** The versioned per-output media recipes admitted by the planned job lane. */
export const miniToolPlanRecipeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("inspect_video"), inputId }),
  z.strictObject({ kind: z.literal("frame"), inputId, frameIndex: index }),
  z.strictObject({ kind: z.literal("segment"), inputId, range, audioEnd: z.number().positive().optional() }),
  z.strictObject({ kind: z.literal("people"), inputId, anchor: miniToolAnchorSchema, profile }),
  z.strictObject({ kind: z.literal("scene_cuts"), inputId, range, profile }),
]) satisfies z.ZodType<MiniToolPlanRecipe>;

/** The request holding a complete chunk's input and output identities. */
export const miniToolPlanJobRequestSchema = z.strictObject({
  schemaVersion: z.literal(2),
  jobId: z.string().min(1).max(200),
  containerClass: z.string().min(1).max(100),
  deadlineAt: z.number().int().positive(),
  limits: miniToolPlanLimitsSchema,
  inputs: z.array(z.strictObject({ inputId, storageKey })).min(1),
  outputs: z.array(z.strictObject({
    outputIndex: index,
    storageKey,
    contentType: z.string().min(1).max(100),
    coverKey: storageKey.optional(),
    recipe: miniToolPlanRecipeSchema,
  })).min(1).max(MINI_TOOL_JOB_MAX_OUTPUTS),
}).superRefine((request, ctx) => {
  const ids = new Set<string>();
  for (const input of request.inputs) {
    if (ids.has(input.inputId)) ctx.addIssue({ code: "custom", message: "Duplicate input identity" });
    ids.add(input.inputId);
  }
  const keys = new Set(request.inputs.map((input) => input.storageKey));
  const indices = new Set<number>();
  for (const output of request.outputs) {
    if (!ids.has(output.recipe.inputId)) ctx.addIssue({ code: "custom", message: "Recipe references an unbound input" });
    if (indices.has(output.outputIndex)) ctx.addIssue({ code: "custom", message: "Duplicate output index" });
    indices.add(output.outputIndex);
    for (const key of [output.storageKey, ...(output.coverKey === undefined ? [] : [output.coverKey])]) {
      if (keys.has(key)) ctx.addIssue({ code: "custom", message: "Output key collides with another capability" });
      keys.add(key);
    }
  }
});

export type MiniToolPlanJobRequest = z.infer<typeof miniToolPlanJobRequestSchema>;

const usage = z.strictObject({ wallMs: z.number().nonnegative(), cpuUsec: z.number().nonnegative().nullable() });
const measuredOutput = ingestMeasurements.extend({
  outputIndex: index,
  storageKey,
  cover: z.strictObject({
    storageKey,
    sha256: ingestMeasurements.shape.sha256,
    sizeBytes: z.number().int().positive(),
    contentType: z.string().min(1).max(100),
    width: ingestMeasurements.shape.width,
    height: ingestMeasurements.shape.height,
  }).nullish().transform((value) => value ?? null),
});

/** The indexed report of a planned job's actual written objects. */
export const miniToolPlanJobReportSchema = z.discriminatedUnion("state", [
  z.strictObject({ schemaVersion: z.literal(2), state: z.literal("starting") }),
  z.strictObject({ schemaVersion: z.literal(2), state: z.literal("running") }),
  z.strictObject({ schemaVersion: z.literal(2), state: z.literal("done"), outputs: z.array(measuredOutput), usage }),
  z.strictObject({ schemaVersion: z.literal(2), state: z.literal("failed"), outputs: z.array(measuredOutput), reason: z.enum(CONTAINER_FAILURES), usage: usage.nullable() }),
]);

export type MiniToolPlanJobReport = z.infer<typeof miniToolPlanJobReportSchema>;

/** A job's exact read and write capabilities. */
export interface MiniToolPlanAccess {
  reads: string[];
  writes: Record<string, string>;
}

/**
 * Resolve the frozen inputs and outputs into the container's capabilities.
 * @param request - The planned job request.
 * @returns The exact registered read and output write keys.
 * @throws {z.ZodError} When the frozen request is invalid.
 */
export function miniToolPlanAccess(request: unknown): MiniToolPlanAccess {
  const parsed = miniToolPlanJobRequestSchema.parse(request);
  const writes: Record<string, string> = {};
  for (const output of parsed.outputs) {
    writes[output.storageKey] = output.contentType;
    if (output.coverKey !== undefined) writes[output.coverKey] = "image/png";
  }
  return { reads: [...new Set(parsed.inputs.map((input) => input.storageKey))], writes };
}

/**
 * Compare a repeated submission with the job's original frozen request.
 * @param accepted - The originally accepted request.
 * @param incoming - The repeated submission.
 * @returns Whether both complete parsed requests have the same frozen identity.
 * @throws {z.ZodError} When either request is invalid.
 */
export function sameMiniToolPlanJob(accepted: unknown, incoming: unknown): boolean {
  return canonicalMiniToolValue(miniToolPlanJobRequestSchema.parse(accepted)) === canonicalMiniToolValue(miniToolPlanJobRequestSchema.parse(incoming));
}

/**
 * Validate an indexed report against the job's original output identities.
 * @param request - The frozen job request.
 * @param report - The actual report received from the ingest Worker.
 * @returns The measured report bound to its declared output identities.
 * @throws {z.ZodError} When the request or report cannot be read.
 * @throws {Error} When the measured report conflicts with the declared capabilities.
 */
export function readMiniToolPlanJobReport(request: unknown, report: unknown): MiniToolPlanJobReport {
  const parsed = miniToolPlanJobRequestSchema.parse(request);
  const read = miniToolPlanJobReportSchema.parse(report);
  if (read.state === "starting" || read.state === "running") return read;
  const expected = new Map(parsed.outputs.map((output) => [output.outputIndex, output]));
  const observed = new Set<number>();
  for (const output of read.outputs) {
    const declared = expected.get(output.outputIndex);
    if (!declared || observed.has(output.outputIndex) || declared.storageKey !== output.storageKey || declared.contentType !== output.contentType) {
      throw new Error("Planned job report has an undeclared or duplicated output identity");
    }
    if (output.cover !== null && (output.cover.storageKey !== declared.coverKey || output.cover.contentType !== "image/png")) {
      throw new Error("Planned job report has an undeclared cover");
    }
    if (output.upright !== null) throw new Error("Planned job report has an undeclared upright copy");
    observed.add(output.outputIndex);
  }
  if (read.state === "done" && observed.size !== expected.size) throw new Error("Planned job report is missing declared outputs");
  return read;
}
