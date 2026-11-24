// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Exponential retry backoff, shared by the refund loop and the billing
 * outbox relays (inner#1993 §5.2).
 */

/**
 * How long to wait before the n-th retry: `min(base * 2^(n-1), max)`.
 * @param attempt - Which retry this is, counting from 1.
 * @param config - The backoff bounds.
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
