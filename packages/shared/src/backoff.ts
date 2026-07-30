// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Retry / backoff primitives shared across every retry site — backend
 * (HTTP transport, storage download, BullMQ job retry) and browser
 * (asset upload) alike.
 *
 * These live in `@breatic/shared` rather than `@breatic/core` because the
 * browser needs them too: the upload path jitters its own retries, and
 * `shared` is the only workspace package the frontend may import. They are
 * pure arithmetic with an injectable randomness source, so nothing here
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
