// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The single home of "should this request be replayed".
 *
 * Two kinds of knowledge meet here, and keeping them apart is the design:
 *
 *   - **Protocol semantics**, which this layer owns. A 429 or 408 says the
 *     server did not process the request, so replaying is safe no matter what
 *     the request does. Other 4xx are facts a replay cannot change.
 *   - **The one thing only the caller knows**: whether delivering this exact
 *     request a second time causes additional side effects. The transport
 *     cannot see that a `POST /predictions` costs money upstream, so the
 *     caller states it via `replaySafe`.
 *
 * `replaySafe` is a statement of fact about the endpoint, not a retry
 * preference. HTTP method is only a hint at that fact and a poor one in both
 * directions: a submit carrying a vendor idempotency key is a POST that IS
 * replay-safe, and a side-effecting GET is not.
 */

import { exponentialJitterDelay } from "@shared/backoff.js";
import {
  BASE_DELAY_MS,
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
} from "@shared/http/constants.js";

/**
 * The verdict: replay or not, and how long to wait first.
 *
 * Deliberately just those two facts. An earlier cut also produced a term
 * naming WHY — eight for refusals, five for authorizations — and the loop
 * never read one of them: it branches on `retry` alone. Thirteen terms were
 * computed, carried across a module boundary, and dropped.
 */
export type RetryDecision = { retry: false } | { retry: true; delayMs: number };

/** Everything the predicate needs; no ambient state, no clock, no IO. */
export interface RetryInput {
  /**
   * Response status, or undefined when no response arrived at all.
   *
   * Absence is the whole signal for a transport failure. An earlier version
   * also carried a term naming WHICH failure — timeout, network, cancelled,
   * deterministic — and every one of them was answered the same way, so the
   * term existed only to be discarded.
   */
  status?: number;
  /**
   * Caller-owned fact: delivering this exact request again produces no
   * additional side effects.
   */
  replaySafe: boolean;
  /**
   * Whether the request body can physically be delivered a second time.
   *
   * Transport-owned, unlike `replaySafe`: a one-shot source is consumed by the
   * first delivery, and handing the spent source back to fetch rejects with a
   * TypeError about a disturbed body — which then looks like a network failure
   * and gets replayed again, so the caller ends up holding that TypeError
   * instead of the status the server actually sent.
   */
  bodyReplayable?: boolean;
  /** The wait the response asked for, ALREADY PARSED, or null. */
  retryAfterMs?: number | null;
  /** 1-based delivery counter. */
  attempt: number;
  /** Uniform `[0, 1)` source; injectable for deterministic tests. */
  rand?: () => number;
}

/**
 * IMF-fixdate, the preferred HTTP-date form (RFC 9110 §5.6.7) and the one
 * `Date.prototype.toUTCString` emits: `Thu, 30 Jul 2026 12:00:04 GMT`.
 *
 * The shape is validated before parsing because `Date.parse` is far looser
 * than the spec requires — ECMAScript only mandates ISO 8601 and leaves
 * everything else implementation-defined, so V8 guesses. Measured on Node 24:
 * `Date.parse("-5")` yields 2001-05-01 and `Date.parse("3.5.1")` yields
 * 2001-03-05. Both are past instants, so without this gate a malformed header
 * would clamp to a 0 ms wait — an immediate hammering retry — instead of
 * falling back to our own backoff.
 */
const IMF_FIXDATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Whether a parsed instant still names the day the header claimed.
 *
 * The shape gate accepts "31 Feb" because it only checks digits and a month
 * name; `Date.parse` then rolls it into March instead of rejecting it. Reading
 * the day and month back off the parsed instant catches exactly that.
 * @param raw - The IMF-fixdate string as sent.
 * @param at - What `Date.parse` made of it.
 * @returns True when the parsed instant is the day the string named.
 */
function datesBackToItself(raw: string, at: number): boolean {
  const [, day, month] = /^[A-Za-z]{3}, (\d{2}) ([A-Za-z]{3})/.exec(raw) ?? [];
  if (day === undefined || month === undefined) return false;
  const parsed = new Date(at);
  return (
    parsed.getUTCDate() === Number(day) &&
    parsed.toUTCString().slice(8, 11).toLowerCase() === month.toLowerCase()
  );
}

/**
 * Whether a status is one the server sends to say its own side failed.
 *
 * Bounded at both ends on purpose. `status >= 500` alone treated anything
 * above 599 as a retryable server error, and there is no such status class.
 * @param status - The response status, or undefined when none arrived.
 * @returns True for 500..599.
 */
function isServerError(status: number | undefined): boolean {
  return status !== undefined && status >= 500 && status < 600;
}

/**
 * Parse a `Retry-After` value into the wait it names, in milliseconds.
 *
 * Accepts delay-seconds and IMF-fixdate, rejecting everything else so a
 * malformed header falls back to our own backoff rather than to zero. Note
 * `Number("")` and `Number("  ")` are both `0` rather than `NaN`, so a
 * digits-only pattern does the validation instead of a numeric cast.
 * @param raw - The raw header value, if the response carried one.
 * @param nowMs - Current epoch milliseconds, for the HTTP-date form.
 * @returns The wait the server asked for, or null when it named none we can read.
 */
export function parseRetryAfter(
  raw: string | null | undefined,
  nowMs: number,
): number | null {
  if (raw == null) return null;
  // A server that sent the header twice arrives here as "5, 5" — `Headers.get`
  // joins repeats with a comma. Retry-After is a singleton field, so a repeat
  // is malformed; but rejecting the whole thing meant falling back to
  // sub-second jitter and hammering the very server that had just asked for
  // room. When every copy says the same thing the instruction is unambiguous,
  // so honour it. When they disagree there is no instruction to honour.
  const parts = raw.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  const value = parts.length > 1 && new Set(parts).size === 1 ? parts[0]! : raw.trim();

  if (/^\d+$/.test(value)) {
    return Number(value) * 1000;
  }

  if (!IMF_FIXDATE.test(value)) return null;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  // `Date.parse` rolls a calendar-invalid date over rather than rejecting it,
  // so "Tue, 31 Feb 2027" becomes early March — a wait of weeks, which then
  // exceeds the ceiling and stops the request outright. A date that does not
  // exist is a broken header, not an instruction.
  if (!datesBackToItself(value, at)) return null;
  const wait = at - nowMs;
  // A date already past carries no usable instruction — it describes a moment
  // that has gone, whether through clock skew or a cached response. Flooring
  // it to zero turned the polite path into the impolite one: three deliveries
  // with no gap between them. An explicit `Retry-After: 0` is different and is
  // still honoured: that is an instruction, not a stale one.
  return wait > 0 ? wait : null;
}

/**
 * How long to wait before an authorized replay.
 *
 * The server's figure when it gave a usable one, otherwise our own
 * full-jittered exponential backoff. The ceiling only decides whether to wait
 * at all: past it the request stops and the response — `Retry-After` header
 * and all — goes back to the caller, which can read the figure itself.
 * Shortening the server's number to one we find convenient is not a third
 * option; it disregards the only party that knows when it will be ready.
 * @param input - The decision input.
 * @returns A retry carrying the wait, or a refusal when the wait is too long.
 */
function scheduleRetry(input: RetryInput): RetryDecision {
  // No response means no header could have arrived — ignore any value passed
  // alongside its absence.
  const asked = input.status === undefined ? null : input.retryAfterMs ?? null;
  if (asked === null) {
    // The only place a number we invented is allowed. A dropped connection
    // tells us nothing about when the far side will be well again, so somebody
    // has to estimate, and full-jittered exponential backoff is the standard
    // estimate. `attempt` is 1-based; the backoff helper is 0-based.
    return {
      retry: true,
      delayMs: exponentialJitterDelay(input.attempt - 1, BASE_DELAY_MS, input.rand),
    };
  }
  if (asked > MAX_RETRY_AFTER_MS) return { retry: false };
  return { retry: true, delayMs: asked };
}

/**
 * Decide whether a failed request may be replayed, and after how long.
 *
 * Total: every input yields a verdict. The ordering is load-bearing and is
 * asserted in the tests — a rate-limited non-replayable submit must still back
 * off and retry, because 429 is the one case where the server has told us
 * nothing happened.
 * @param input - Status (or its absence), the caller's declaration, the body
 *   fact, the parsed server wait, and the delivery counter.
 * @returns Replay or not, with the wait when replaying.
 */
export function decideRetry(input: RetryInput): RetryDecision {
  // Platform semantics: not "should we replay" but "can we". Ahead of
  // everything about status, because no status changes it — a spent body has
  // nothing left to send, whatever the server said.
  if (input.bodyReplayable === false) return { retry: false };

  if (input.attempt > MAX_RETRIES) return { retry: false };

  const { status } = input;

  // Protocol semantics: true regardless of what the request does. 429 and 408
  // state the server did NOT process the request, so a replay cannot produce a
  // second side effect and the caller's declaration does not apply.
  if (status === 429 || status === 408) return scheduleRetry(input);
  // Any other answer from the server is a fact a replay cannot change: a 4xx
  // is about this request, and a 2xx or an unfollowed 3xx is not a failure at
  // all.
  if (status !== undefined && !isServerError(status)) return { retry: false };

  // The one thing only the caller knows. Reached by a 5xx and by the absence
  // of any response.
  if (!input.replaySafe) return { retry: false };
  return scheduleRetry(input);
}
