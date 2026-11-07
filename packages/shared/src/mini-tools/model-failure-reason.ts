// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { z } from "zod";
import { modelRunRetryable } from "@shared/mini-tools/model-run-retryable.js";

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
