// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * When to send a run-once request again under its key (inner#1490), shared by
 * the run-once presses and the upload ticket (inner#1968 design 3.2).
 */

import { exponentialJitterDelay } from '@breatic/shared';

import { ApiException } from '@web/data/api/types';

/**
 * Ceiling of one backoff wait between re-sends (inner#1490 §6.2); a wait the
 * server names with Retry-After is taken as given.
 */
const MAX_RESEND_WAIT_MS = 30_000;

/**
 * Ceiling of the first jittered wait between re-sends; it doubles per re-send,
 * up to MAX_RESEND_WAIT_MS.
 */
const RESEND_BASE_MS = 1_000;

/**
 * How long to wait before asking again, or null when the answer is final.
 *
 * The server's `Idempotency-Status: done` is final either way. Without it, no
 * answer, a press still running, a throttle and any 5xx (a proxy timing out
 * included) leave the outcome unknown; anything else was refused before it ran.
 * @param err - What the send rejected with.
 * @param attempt - Re-sends so far.
 * @returns Milliseconds to wait, or null.
 */
export function resendWait(err: unknown, attempt: number): number | null {
  if (!(err instanceof ApiException) || err.idempotencyStatus === 'done') return null;
  const unknown =
    err.idempotencyStatus === 'in_progress' ||
    err.network ||
    err.status === 429 ||
    err.status >= 500;
  if (!unknown) return null;
  if (err.retryAfterSeconds !== undefined) return err.retryAfterSeconds * 1000;
  return Math.min(MAX_RESEND_WAIT_MS, exponentialJitterDelay(Math.min(attempt, 5), RESEND_BASE_MS));
}
