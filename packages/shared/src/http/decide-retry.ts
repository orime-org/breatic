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

/** Delay-seconds: the first of the two forms RFC 9110 §5.6.7 allows. */
const DELAY_SECONDS = String.raw`\d+`;

/**
 * IMF-fixdate, the second form and the one `Date.prototype.toUTCString`
 * emits: `Thu, 30 Jul 2026 12:00:04 GMT`.
 *
 * What this shape is FOR: it defines the unit that may be repeated, so the
 * back-reference below can recognise the same value sent twice. That is its
 * whole job here.
 *
 * It is deliberately NOT the thing that rejects a malformed date, and an
 * earlier version of this comment claimed otherwise. Measured: loosen this to
 * `[A-Za-z]{3}, [^,]+`, or drop the shape check entirely, and every one of the
 * twenty inputs the tests cover still parses to the same answer — including
 * `…12:00:05 UTC` and a lower-case `gmt`, which `Date.parse` accepts. What
 * refuses those is `datesBackToItself`: `toUTCString` always re-emits `GMT`,
 * so neither string survives the round trip. Keeping the strict form here
 * costs nothing and states the format honestly, but it is not load-bearing
 * for validity — writing that it was sent me looking in the wrong place.
 */
const IMF_FIXDATE = String.raw`[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT`;

/**
 * One legal value, optionally sent more than once with the same content.
 *
 * Shape-checking and duplicate-collapsing are ONE question, not two, and
 * splitting them was a real defect: the previous cut split on commas to find
 * repeats, but IMF-fixdate carries a comma of its own (`Thu, 30 Jul…`), so a
 * repeated date could never collapse and fell through to the shape check as
 * one long string, which of course failed. For months only the seconds form
 * had working duplicate handling, while the comment claimed both did.
 *
 * A back-reference rather than a general "some prefix, repeated": the value
 * alternatives are fixed shapes, so there is nothing for a hostile header to
 * make expensive. Measured at 5000 copies plus a non-matching tail: under a
 * millisecond, and pinned by a test.
 */
const ONE_VALUE_POSSIBLY_REPEATED = new RegExp(
  `^(${DELAY_SECONDS}|${IMF_FIXDATE})(?:,\\s*\\1)*$`,
);

/** The seconds form on its own, to tell which alternative matched. */
const IS_DELAY_SECONDS = new RegExp(`^${DELAY_SECONDS}$`);

/**
 * Whether the instant we parsed writes itself back out as the string we read.
 *
 * The whole check, and it is one comparison rather than a field-by-field
 * inspection ON PURPOSE. IMF-fixdate is exactly the format `toUTCString`
 * emits, so a legal value must survive the round trip unchanged — which means
 * one equality covers every field at once, and no field can be forgotten.
 *
 * That matters because `Date.parse` is generous in three different ways, and
 * an earlier version of this check only caught the first (measured on Node 24):
 *
 *   - it ROLLS an impossible day:  "31 Feb 2027"        -> 3 Mar 2027
 *   - it IGNORES the weekday:      "Mon, 30 Jul 2026"   -> that Thursday
 *   - it TRUNCATES an out-of-range seconds field: "12:05:99" -> 12:05:00
 *
 * The third is the one with teeth. This header form names an INSTANT, not a
 * duration, and the wait is the distance from now to it — so reading
 * "12:05:99" as 12:05:00 does not shorten a wait by 99 seconds, it points at a
 * different moment than the one the server wrote, and the wait we then serve
 * is a figure nobody sent. That is the failure this module refuses everywhere
 * else.
 *
 * A NaN instant needs no separate guard: `new Date(NaN).toUTCString()` is
 * "Invalid Date", which equals no legal header.
 * @param raw - The IMF-fixdate string as sent, already shape-checked.
 * @param at - What `Date.parse` made of it.
 * @returns True when re-emitting the parsed instant reproduces `raw` exactly.
 */
function datesBackToItself(raw: string, at: number): boolean {
  return new Date(at).toUTCString() === raw;
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
  // One question, asked once: is this a legal value, possibly sent more than
  // once with the same content? A server that sent the field twice arrives
  // here as a single comma-joined string, because that is what `Headers.get`
  // does with repeats. Retry-After is a singleton field so a repeat is
  // malformed — but rejecting it outright dropped us to sub-second jitter
  // against the very server that had just asked for room. Identical copies
  // carry an unambiguous instruction; copies that disagree carry none.
  const matched = ONE_VALUE_POSSIBLY_REPEATED.exec(raw.trim());
  if (matched === null) return null;
  const value = matched[1]!;

  if (IS_DELAY_SECONDS.test(value)) {
    return Number(value) * 1000;
  }

  const at = Date.parse(value);
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
 * Total: every input yields a verdict. THREE orderings are load-bearing, and
 * each has a test that goes red when it is moved:
 *
 *   - A spent body outranks every status, 429 included. 429 is the only
 *     status that would otherwise authorise a replay no matter what, so it is
 *     also the only one that can prove this check runs first.
 *   - The attempt budget outranks 429, and this is the one that terminates the
 *     loop. A success leaves through its own return, but a request that keeps
 *     failing has exactly one way out: this function refusing. 429 is the
 *     branch that says "retry" without ever consulting the budget, so if the
 *     budget is checked after it, a server that answers 429 forever is never
 *     given up on. Measured: move the check below the 429 branch and the call
 *     is still going after 15 seconds and six deliveries.
 *   - 429 outranks the caller's own declaration, because it is the one case
 *     where the server has told us nothing happened — so a rate-limited
 *     non-replayable submit must still back off and retry. Backwards, this
 *     fails the request outright in the situation that most deserves patience.
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
