// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** How one attempt at an upstream failed. */
export type Failure =
  | { kind: "not_sent" }
  | { kind: "no_answer" }
  | { kind: "http_status"; status: number }
  | { kind: "model_not_found" }
  | { kind: "aborted" };

/** Where the call was when it failed. */
export type Phase = "media_submit" | "llm_before_content";

/** What to do next: try the next upstream, try this one again, or stop and surface the failure. */
export type Decision = "switch" | "retry" | "stop";

/**
 * Decide what a failure leads to (design section 5.3).
 * @param failure - How the attempt failed.
 * @param phase - Where the call was.
 * @param retriesUsed - Retries already spent on this upstream.
 * @param maxRetries - Retries allowed on one upstream before switching (LLM only).
 * @returns The next step.
 */
export function decide(failure: Failure, phase: Phase, retriesUsed: number, maxRetries: number): Decision {
  if (failure.kind === "not_sent" || failure.kind === "model_not_found") return "switch";
  if (failure.kind !== "http_status") return "stop";
  if (failure.status !== 429 && failure.status < 500) return "stop";
  return phase === "llm_before_content" && retriesUsed < maxRetries ? "retry" : "switch";
}
