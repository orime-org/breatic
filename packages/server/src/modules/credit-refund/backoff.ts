// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The refund loop's retry backoff (inner#1410 §7.1, §7.4).
 */

/**
 * How long to wait before the n-th retry: `min(base * 2^(n-1), max)`.
 * @param attempt - Which retry this is, counting from 1.
 * @param config - The backoff bounds from `config/credit-refund.yaml`.
 * @param config.backoffBaseSeconds - The first wait.
 * @param config.backoffMaxSeconds - The longest wait.
 * @returns Seconds to wait.
 * @throws {RangeError} When `attempt` is not a positive integer.
 */
export function nextAttemptDelaySeconds(
  attempt: number,
  config: { backoffBaseSeconds: number; backoffMaxSeconds: number },
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(`attempt must be a positive integer, got ${attempt}`);
  }
  return Math.min(config.backoffBaseSeconds * 2 ** (attempt - 1), config.backoffMaxSeconds);
}

/**
 * Whether a disposition has used up its attempts (E11, `attempts_exhausted`).
 * @param attemptCount - Attempts that ended without an answer so far (`attempt_count`), the first included.
 * @param config - The limit from `config/credit-refund.yaml`.
 * @param config.maxAttempts - How many attempts a disposition gets, the first included.
 * @returns True when no attempt is left.
 */
export function attemptsExhausted(attemptCount: number, config: { maxAttempts: number }): boolean {
  return attemptCount >= config.maxAttempts;
}

/**
 * How long until the next lookup of a disposition waiting on Stripe. These
 * lookups are not counted, so the wait grows with the time already waited
 * since the first call: as long again, between the backoff base and max.
 * @param firstCalledAt - When Stripe was first called, or null.
 * @param config - The backoff bounds from `config/credit-refund.yaml`.
 * @param config.backoffBaseSeconds - The shortest wait.
 * @param config.backoffMaxSeconds - The longest wait.
 * @param nowMs - The clock, in epoch milliseconds.
 * @returns Seconds to wait.
 */
export function waitedBackoffSeconds(
  firstCalledAt: Date | null,
  config: { backoffBaseSeconds: number; backoffMaxSeconds: number },
  nowMs: number,
): number {
  const waited = firstCalledAt ? (nowMs - firstCalledAt.getTime()) / 1000 : 0;
  return Math.min(Math.max(waited, config.backoffBaseSeconds), config.backoffMaxSeconds);
}
