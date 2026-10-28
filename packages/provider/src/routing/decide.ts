// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { isServerError } from "@provider/http/request.js";

/** How one attempt at an upstream failed. */
export type Failure =
  | { kind: "not_sent" }
  | { kind: "no_answer" }
  | { kind: "http_status"; status: number }
  | { kind: "model_not_found" }
  | { kind: "insufficient_balance" }
  | { kind: "aborted" };

/** Where the call was when it failed. */
export type Phase = "media_submit" | "llm_before_content";

/** What to do next: try the next upstream, try this one again, or stop and surface the failure. */
export type Decision = "switch" | "retry" | "stop";

/**
 * Whether a status says the upstream may serve the same request if asked again: 408, 429
 * and 5xx, and before an LLM's content also 409, the statuses the AI SDK retries (DD 25).
 * @param status - The status.
 * @param phase - Where the call was.
 * @returns True for a passing status.
 */
export function passingStatus(status: number, phase: Phase): boolean {
  return status === 408 || status === 429 || isServerError(status) || (phase === "llm_before_content" && status === 409);
}

/**
 * Decide what a failure leads to (design section 5.3).
 * @param failure - How the attempt failed.
 * @param phase - Where the call was.
 * @param retriesUsed - Retries already spent on this upstream.
 * @param maxRetries - Retries allowed on one upstream before switching (LLM only).
 * @returns The next step.
 */
export function decide(failure: Failure, phase: Phase, retriesUsed: number, maxRetries: number): Decision {
  // Retrying the same upstream cannot help, because the upstream lacks the model or the account its
  // balance; a request that never left also goes to the next upstream at once.
  if (failure.kind === "not_sent" || failure.kind === "model_not_found" || failure.kind === "insufficient_balance") return "switch";
  if (failure.kind !== "http_status") return "stop";
  if (!passingStatus(failure.status, phase)) return "stop";
  return phase === "llm_before_content" && retriesUsed < maxRetries ? "retry" : "switch";
}
