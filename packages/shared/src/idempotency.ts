// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Run-once requests — the contract the server and the browser both read.
 *
 * One press of these buttons carries one `Idempotency-Key`. The server
 * remembers the finished answer for the scope's retention and replays it to
 * any repeat of that key; the browser keeps re-sending an unanswered press
 * with the same key, and must stop before the server forgets, or the last
 * re-send would run the request a second time.
 */

/** The requests that run once per press, by the scope the server keys them on. */
export const IDEMPOTENCY_SCOPES = [
  "generate",
  "understand",
  "mini-tool",
  "conversation",
  "membership",
  "project",
  "credits-checkout",
] as const;

/** One of the run-once requests. */
export type IdempotencyScope = (typeof IDEMPOTENCY_SCOPES)[number];

/** Seconds in a day. */
const DAY_SECONDS = 24 * 60 * 60;

/**
 * How long the server keeps a finished answer, per scope.
 *
 * A credits checkout's retention is also its Stripe session's lifetime. A
 * membership checkout keeps Stripe's default lifetime of 24 hours, the most
 * Stripe accepts, so its retention stays within that. Because the browser
 * stops re-sending IDEMPOTENCY_CLIENT_MARGIN_SECONDS before the retention runs
 * out, a replay it receives never hands back a session that has expired.
 */
export const IDEMPOTENCY_RETENTION_SECONDS: Readonly<Record<IdempotencyScope, number>> = {
  generate: DAY_SECONDS,
  understand: DAY_SECONDS,
  "mini-tool": DAY_SECONDS,
  conversation: DAY_SECONDS,
  membership: DAY_SECONDS,
  project: DAY_SECONDS,
  "credits-checkout": 2 * 60 * 60,
};

/**
 * How long before the server forgets that the browser stops re-sending.
 *
 * Longer than a request can take to reach the server once sent (Node's
 * `requestTimeout` gives one 300 seconds), so the last re-send reaches the
 * server while the answer is still kept, and a replayed checkout session has
 * at least about five minutes left.
 */
export const IDEMPOTENCY_CLIENT_MARGIN_SECONDS = 600;

/**
 * The wall-clock instant the browser stops re-sending an unanswered press.
 * @param scope - The request the press made.
 * @param pressedAt - `Date.now()` at the press; wall clock, so a laptop
 *   asleep in between still counts.
 * @returns Epoch milliseconds after which no re-send goes out.
 */
export function idempotencyRetryDeadline(scope: IdempotencyScope, pressedAt: number): number {
  return (
    pressedAt +
    (IDEMPOTENCY_RETENTION_SECONDS[scope] - IDEMPOTENCY_CLIENT_MARGIN_SECONDS) * 1000
  );
}
