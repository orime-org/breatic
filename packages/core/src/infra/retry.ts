// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The BullMQ job-retry strategy, and nothing else.
 *
 * This file used to hold a byte-identical copy of `fullJitter` and
 * `exponentialJitterDelay` alongside it, because the shared HTTP transport
 * lives in `@breatic/shared` and `shared` cannot import `core`. While core had
 * retry callers of its own — worker's HTTP loop, the storage download — both
 * copies had a reason to exist. Those callers moved onto the transport, and
 * with them the reason: the maths now comes from `@breatic/shared`, and the
 * only thing left here is the part the browser has no use for.
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
