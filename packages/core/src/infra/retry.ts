// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Backend-only retry plumbing.
 *
 * The arithmetic primitives (`fullJitter`, `exponentialJitterDelay`) live in
 * `@breatic/shared` because the browser needs them too — the asset upload
 * jitters its own retries and `shared` is the only workspace package the
 * frontend may import. What stays here is the piece the browser can never
 * use: the BullMQ strategy adapter.
 */

import { exponentialJitterDelay } from "@breatic/shared";

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
