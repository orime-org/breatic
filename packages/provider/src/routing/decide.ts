// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

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
 * and 5xx, and before an LLM's content also 409, the statuses the AI SDK retries.
 * @param status - The status.
 * @param phase - Where the call was.
 * @returns True for a passing status.
 */
export function passingStatus(status: number, phase: Phase): boolean {
  return status === 408 || status === 429 || isServerError(status) || (phase === "llm_before_content" && status === 409);
}

/**
 * Decide what a failure leads to.
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

/** How a call on an account's key set failed in a way the account, not the request, has to fix. */
export type AccountKeyFailureKind = "account_key_missing" | "account_key_failed" | "upstream_unavailable";

/** Why an upstream turned an account's key down, for `account_key_failed`. */
export type AccountKeyFailureReason = "invalid" | "no_balance" | "model_not_found" | "rate_limited";

/** How a failure on an account's key reads, and whether asking again could change it. */
export interface Turned {
  kind: AccountKeyFailureKind;
  reason?: AccountKeyFailureReason;
  /** True when asking again cannot change it. */
  lasting: boolean;
}

/**
 * How a failure on an account's key reads: a missing model or balance and a 401 are lasting; a 429 is the key's rate
 * limit, and a connection that was never made, a 408 or a 5xx the upstream's, both passing.
 * @param failure - The failure class, read the answering upstream's way.
 * @param phase - Where the call was.
 * @returns The reading, or undefined for a failure that is not the account's (a refused request, a lost answer, an abort).
 */
export function accountFailureOf(failure: Failure | null, phase: Phase): Turned | undefined {
  if (failure === null) return undefined;
  if (failure.kind === "model_not_found") return { kind: "account_key_failed", reason: "model_not_found", lasting: true };
  if (failure.kind === "insufficient_balance") return { kind: "account_key_failed", reason: "no_balance", lasting: true };
  if (failure.kind === "not_sent") return { kind: "upstream_unavailable", lasting: false };
  if (failure.kind !== "http_status") return undefined;
  if (failure.status === 401) return { kind: "account_key_failed", reason: "invalid", lasting: true };
  if (failure.status === 429) return { kind: "account_key_failed", reason: "rate_limited", lasting: false };
  return passingStatus(failure.status, phase) ? { kind: "upstream_unavailable", lasting: false } : undefined;
}
