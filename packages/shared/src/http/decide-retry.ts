// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The single home of "should this request be replayed".
 *
 * Two knowledge domains meet here, and keeping them apart is the design:
 *
 *   - **Protocol semantics**, which this layer owns. A 429 or 408 says the
 *     server did not process the request, so replaying is safe no matter
 *     what the request does. Other 4xx are facts a replay cannot change.
 *   - **Application semantics**, which only the caller knows: whether
 *     delivering this exact request a second time causes additional side
 *     effects. The transport cannot see that a `POST /predictions` costs
 *     money upstream, so the caller states it via `replaySafe`.
 *
 * `replaySafe` is a statement of fact about the endpoint, not a retry
 * preference. HTTP method is only a hint at that fact and a poor one in
 * both directions: a submit carrying a vendor idempotency key is a POST
 * that IS replay-safe, and a side-effecting GET is not.
 */

import { exponentialJitterDelay } from "@shared/backoff.js";
import { BASE_DELAY_MS, MAX_RETRIES, MAX_RETRY_AFTER_MS } from "@shared/http/constants.js";

/** Why a replay was declined. */
export type RetryRefusal =
  /** The caller stated that replaying has side effects. */
  | "not_replay_safe"
  /** A 4xx other than 408/429 — a fact, not weather. */
  | "client_error"
  /** The caller cancelled (a user pressed stop). */
  | "caller_aborted"
  /**
   * The caller identified this failure as deterministic — a replay would
   * hit the same wall. An SSRF-blocked address is the motivating case.
   */
  | "fatal_error"
  /** The attempt budget is spent. */
  | "attempts_exhausted"
  /** Neither a failing status nor a transport error was present. */
  | "nothing_to_retry";

/** Why a replay was authorized. */
export type RetryTrigger =
  /** 429 — the server states it did not process us. */
  | "rate_limited"
  /** 408 — the server gave up reading the request. */
  | "request_timeout"
  | "server_error"
  | "network_error"
  | "attempt_timeout";

/** The verdict, carrying the wait only when a replay is authorized. */
export type RetryDecision =
  | { retry: false; reason: RetryRefusal }
  | { retry: true; reason: RetryTrigger; delayMs: number };

/**
 * How a request failed when no response arrived.
 *
 * `fatal` is for deterministic rejections raised by an injected fetch — the
 * caller identifies them, because only it knows what its own implementation
 * throws. The agent's SSRF guard is the motivating case: a blocked address
 * is blocked on every attempt, so replaying it only burns the budget.
 */
export type TransportErrorKind =
  | "timeout"
  | "network"
  | "caller_aborted"
  | "fatal";

/** Everything the predicate needs; no ambient state, no clock, no IO. */
export interface RetryInput {
  /** Response status, or undefined when no response arrived. */
  status?: number;
  /** Set when no response arrived, naming which transport failure it was. */
  transportError?: TransportErrorKind;
  /** Raw `Retry-After` header value, when the response carried one. */
  retryAfter?: string | null;
  /**
   * Caller-owned fact: delivering this exact request again produces no
   * additional side effects.
   */
  replaySafe: boolean;
  /** 1-based attempt counter (1 = the first retry being considered). */
  attempt: number;
  /** Uniform `[0, 1)` source; injectable for deterministic tests. */
  rand?: () => number;
  /** Clock for HTTP-date `Retry-After`; injectable for deterministic tests. */
  now?: () => number;
}

/**
 * IMF-fixdate, the preferred HTTP-date form (RFC 9110 §5.6.7) and the one
 * `Date.prototype.toUTCString` emits: `Thu, 30 Jul 2026 12:00:04 GMT`.
 *
 * The shape is validated before parsing because `Date.parse` is far looser
 * than the spec requires — ECMAScript only mandates ISO 8601 and leaves
 * everything else implementation-defined, so V8 guesses. Measured on Node
 * 24: `Date.parse("-5")` yields 2001-05-01 and `Date.parse("3.5.1")` yields
 * 2001-03-05. Both are past instants, so without this gate a malformed
 * header would clamp to a 0 ms wait — i.e. an immediate hammering retry —
 * instead of falling back to our own backoff.
 *
 * The two obsolete forms (RFC 850 `Sunday, 06-Nov-94 …`, asctime
 * `Sun Nov  6 …`) are deliberately not accepted: a header we cannot read
 * costs only the server's timing hint, since the caller still retries on
 * our own jittered backoff.
 */
const IMF_FIXDATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a `Retry-After` value into a bounded millisecond delay.
 *
 * Accepts delay-seconds and IMF-fixdate, rejecting everything else so a
 * malformed header falls back to our own backoff rather than to zero. Note
 * `Number("")` and `Number("  ")` are both `0` rather than `NaN`, so a
 * digits-only pattern does the validation instead of a numeric cast.
 * @param raw - The raw header value, if the response carried one.
 * @param nowMs - Current epoch milliseconds, for the HTTP-date form.
 * @returns A delay in `[0, MAX_RETRY_AFTER_MS]`, or null when unusable.
 */
function parseRetryAfter(
  raw: string | null | undefined,
  nowMs: number,
): number | null {
  if (raw == null) return null;
  const value = raw.trim();

  if (/^\d+$/.test(value)) {
    return Math.min(Number(value) * 1000, MAX_RETRY_AFTER_MS);
  }

  if (!IMF_FIXDATE.test(value)) return null;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  // A date already in the past means "retry now", never a negative wait.
  return Math.min(Math.max(at - nowMs, 0), MAX_RETRY_AFTER_MS);
}

/**
 * How long to wait before the authorized replay: the server's
 * `Retry-After` when it gave a usable one, otherwise our own
 * full-jittered exponential backoff.
 * @param input - The same input the decision was made from.
 * @returns The wait in milliseconds.
 */
function replayDelayMs(input: RetryInput): number {
  // A transport error means no response existed, so no header could have
  // arrived — ignore any value a caller passed alongside it.
  if (input.transportError === undefined) {
    const fromHeader = parseRetryAfter(input.retryAfter, (input.now ?? Date.now)());
    if (fromHeader !== null) return fromHeader;
  }
  // `attempt` is 1-based; the backoff helper is 0-based.
  return exponentialJitterDelay(input.attempt - 1, BASE_DELAY_MS, input.rand);
}

/**
 * Decide whether a failed request may be replayed, and after how long.
 *
 * **The ordering is load-bearing.** The 429/408 branch runs before the
 * `replaySafe` branch because those two statuses mean the server never ran
 * the request: a rate-limited non-replayable submit is exactly the case
 * that deserves a backoff rather than an outright failure. Reversing them
 * fails requests at the worst possible moment. The abort and budget checks
 * come first so that a cancelled or spent request reports why it stopped
 * rather than which failure it saw.
 * @param input - The failure, the caller's replay-safety fact, and the
 *   attempt counter.
 * @returns A total decision — every input yields either a refusal with a
 *   reason or an authorization with a wait.
 */
export function decideRetry(input: RetryInput): RetryDecision {
  // The user pressed stop. Nothing may resurrect the request.
  if (input.transportError === "caller_aborted") {
    return { retry: false, reason: "caller_aborted" };
  }

  // A deterministic rejection: the same wall on every attempt.
  if (input.transportError === "fatal") {
    return { retry: false, reason: "fatal_error" };
  }

  // Budget before failure kind, so telemetry distinguishes "gave up after
  // trying" from "refused to try".
  if (input.attempt > MAX_RETRIES) {
    return { retry: false, reason: "attempts_exhausted" };
  }

  const { status } = input;

  // ── Protocol semantics: true regardless of what the request does ──
  if (status === 429) {
    return { retry: true, reason: "rate_limited", delayMs: replayDelayMs(input) };
  }
  if (status === 408) {
    return { retry: true, reason: "request_timeout", delayMs: replayDelayMs(input) };
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return { retry: false, reason: "client_error" };
  }

  // ── Application semantics: only the caller knows this ──
  if (!input.replaySafe) {
    return { retry: false, reason: "not_replay_safe" };
  }

  if (status !== undefined && status >= 500) {
    return { retry: true, reason: "server_error", delayMs: replayDelayMs(input) };
  }
  if (input.transportError === "network") {
    return { retry: true, reason: "network_error", delayMs: replayDelayMs(input) };
  }
  if (input.transportError === "timeout") {
    return { retry: true, reason: "attempt_timeout", delayMs: replayDelayMs(input) };
  }

  // A 2xx/3xx status, or neither status nor transport error: not a failure.
  return { retry: false, reason: "nothing_to_retry" };
}
