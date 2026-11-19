// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { modelRunRetryable } from "@shared/mini-tools/model-run-retryable.js";
import { lipsyncFailureReasonSchema, lipsyncFailureRetryable } from "@shared/mini-tools/lipsync-plan.js";
import { MINI_TOOL_RETRY_TOOLS } from "@shared/mini-tools/planned-request-schema.js";
import type { MiniToolExecutionOutput } from "@shared/mini-tools/execution-record.js";

/** One erase failure (execution design §10.4): the step that failed and why. */
export const eraseFailureReasonSchema = z.strictObject({
  kind: z.literal("erase"),
  step: z.enum(["prepare", "mask", "generate", "composite", "stitch", "expired"]),
  category: z.enum(["model_rejected", "model_output_mismatch", "timeout", "failed"]),
});
/** A parsed erase failure reason. */
export type EraseFailureReason = z.infer<typeof eraseFailureReasonSchema>;

/** One expand failure (execution design §10.5): a line per window that did not succeed and the step outside every window. */
export const expandFailureReasonSchema = z.strictObject({
  kind: z.literal("expand"),
  windows: z.array(z.strictObject({
    windowIndex: z.number().int().nonnegative(),
    step: z.enum(["window", "window_mask", "condition", "generate"]),
    category: z.enum(["model_rejected", "timeout", "failed", "stopped"]),
  })),
  shared: z.strictObject({ step: z.enum(["composite", "stitch", "expired"]), category: z.enum(["timeout", "failed"]) }).nullable(),
});
/** A parsed expand failure reason. */
export type ExpandFailureReason = z.infer<typeof expandFailureReasonSchema>;

/**
 * Whether an erase or expand failure can be retried, by shared `modelRunRetryable`.
 * @param reason - The failure reason.
 * @returns True when retrying the failed items can succeed.
 * @throws {z.ZodError} When the reason is malformed.
 */
export function modelFailureRetryable(reason: unknown): boolean {
  const parsed = z.union([eraseFailureReasonSchema, expandFailureReasonSchema]).parse(reason);
  return parsed.kind === "erase" ? modelRunRetryable({ items: [], shared: parsed }) : modelRunRetryable({ items: parsed.windows, shared: parsed.shared });
}

/**
 * Whether a planned run's failed output can be retried, the one decision the terminal commit's pin release, retry
 * admission and the node share (execution design §9.4, §10.5 last paragraph; frames-split §7.15 end of retryability): never for a
 * tool without retry (transitions); a lip-sync, erase or expand reason by its own rule; any other failure, such as a
 * frames or split output's, is retryable.
 * @param tool - The run's tool.
 * @param error - The failed output's error.
 * @returns True when retrying the failed output can succeed.
 * @throws {never} Never.
 */
export function plannedFailureRetryable(tool: string, error: unknown): boolean {
  if (!(MINI_TOOL_RETRY_TOOLS as readonly string[]).includes(tool)) return false;
  if (lipsyncFailureReasonSchema.safeParse(error).success) return lipsyncFailureRetryable(error);
  if (eraseFailureReasonSchema.safeParse(error).success || expandFailureReasonSchema.safeParse(error).success) return modelFailureRetryable(error);
  return true;
}

/**
 * Whether one output of a planned run can be retried now (frames-split §7.15 end of retryability): it failed, no admitted
 * retry has taken it over, and its failure is one a retry can clear (`plannedFailureRetryable`).
 * @param tool - The run's tool.
 * @param output - The run's output.
 * @returns True when the output offers a retry.
 * @throws {never} Never.
 */
export function plannedOutputRetryable(tool: string, output: Pick<MiniToolExecutionOutput, "result" | "takenOver">): boolean {
  return output.result?.status === "failed" && output.takenOver !== true && plannedFailureRetryable(tool, output.result.error);
}
