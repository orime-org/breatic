// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

/** The codes a failed tracking analysis stores (execution design §10.3 code table). */
export const TRACKED_MASK_FAILURE_CODES = ["empty_foreground", "tracking_output_mismatch", "model_rejected", "timeout", "failed"] as const;
/** A tracking failure code. */
export type TrackedMaskFailureCode = (typeof TRACKED_MASK_FAILURE_CODES)[number];

/** The error a failed tracking analysis stores: its code and the step it failed at. */
export const trackedMaskErrorSchema = z.strictObject({ code: z.enum(TRACKED_MASK_FAILURE_CODES), step: z.enum(["prepare", "track", "join"]) });

/**
 * Whether tracking again with the same frozen input can succeed: not when the selection found nothing or the model refused it.
 * @param code - The stored code.
 * @returns True for a retryable code.
 * @throws {never} Never.
 */
export function trackedMaskRetryable(code: TrackedMaskFailureCode): boolean {
  return code !== "empty_foreground" && code !== "model_rejected";
}
