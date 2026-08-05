// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Retry / backoff primitives for the HTTP transport in this package.
 *
 * ⚠️ A BYTE-FOR-BYTE DUPLICATE OF THESE TWO FUNCTIONS LIVES IN
 * `packages/core/src/infra/retry.ts`. Change one and you must change the
 * other, until #49 deletes core's copy and points everything here. The
 * duplicate exists because this transport sits in `shared`, and `shared`
 * cannot import `core` — the dependency runs the other way. core's callers
 * disappear as the transport takes them over (worker's HTTP loop, then the
 * storage download), leaving only its BullMQ job-retry strategy, which will
 * call into this file.
 *
 * They are pure arithmetic with an injectable randomness source, so nothing here
 * touches Node APIs.
 *
 * The BullMQ-specific strategy builder stays in `@breatic/core` — queue
 * plumbing is backend-only and the browser has no use for it.
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
 * Full-jittered exponential backoff for a 0-based attempt index. The ceiling is
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
