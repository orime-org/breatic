// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Retry / backoff primitives shared across the backend retry sites
 * (worker HTTP, storage download, BullMQ job retry — #1625 Slice 2).
 */

/**
 * Apply full jitter to an exponential-backoff ceiling.
 *
 * "Full jitter" (AWS "Exponential Backoff And Jitter") picks a uniformly random
 * delay in `[0, ceilingMs]` so correlated failures do not retry in synchronized
 * waves (thundering herd). Callers compute their own backoff ceiling (e.g.
 * `base * 2 ** attempt`) and hand it here.
 * @param ceilingMs - Upper bound for the delay. A non-positive or NaN ceiling
 *   clamps to 0 so a caller never sleeps a negative or undefined duration.
 * @param rand - Uniform `[0, 1)` source; injectable so tests are deterministic.
 * @returns An integer millisecond delay in `[0, ceilingMs]`.
 */
export function fullJitter(
  ceilingMs: number,
  rand: () => number = Math.random,
): number {
  if (!(ceilingMs > 0)) return 0;
  return Math.round(rand() * ceilingMs);
}

/**
 * Full-jittered exponential backoff for a 0-based attempt index (the worker's
 * self-written HTTP retry loop, where `attempt` starts at 0). The ceiling is
 * `baseMs * 2 ** attempt`; the returned delay is jittered within `[0, ceiling]`.
 * @param attempt - 0-based retry attempt (0 = first retry).
 * @param baseMs - Base delay; the exponential ceiling is `baseMs * 2 ** attempt`.
 * @param rand - Uniform `[0, 1)` source; injectable for deterministic tests.
 * @returns Integer millisecond delay in `[0, baseMs * 2 ** attempt]`.
 */
export function exponentialJitterDelay(
  attempt: number,
  baseMs: number,
  rand: () => number = Math.random,
): number {
  return fullJitter(baseMs * 2 ** attempt, rand);
}

/**
 * Build a BullMQ custom `backoffStrategy` that jitters the exponential backoff.
 *
 * BullMQ passes a **1-based** `attemptsMade` (its builtin exponential is
 * `2 ** (attemptsMade - 1) * delay`), so this normalizes to the same 0-based
 * form before jittering. Assign the result to `WorkerOptions.settings.
 * backoffStrategy` and set the job's `backoff.type` to `"jitter"`.
 * @param baseMs - Base delay for the exponential ceiling.
 * @param rand - Uniform `[0, 1)` source; injectable for deterministic tests.
 * @returns A `(attemptsMade: number) => number` strategy for BullMQ.
 */
export function jitterBackoffStrategy(
  baseMs: number,
  rand: () => number = Math.random,
): (attemptsMade: number) => number {
  return (attemptsMade: number): number =>
    exponentialJitterDelay(attemptsMade - 1, baseMs, rand);
}
