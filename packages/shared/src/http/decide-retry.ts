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
import {
  BASE_DELAY_MS,
  MAX_RETRIES,
  MAX_RETRY_AFTER_INTERACTIVE_MS,
  MAX_RETRY_AFTER_BACKGROUND_MS,
} from "@shared/http/constants.js";

/** Why a replay was declined. */
export type RetryRefusal =
  /** The caller stated that replaying has side effects. */
  | "not_replay_safe"
  /**
   * The request body can only be delivered once, so there is nothing left to
   * send. Distinct from `not_replay_safe`: that one is the caller's fact
   * about consequences, this one is the platform's about the bytes. An
   * on-call engineer needs to tell them apart — the first is a deliberate
   * declaration, the second means a streamed upload cannot be retried at all.
   */
  | "body_not_replayable"
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
  | "nothing_to_retry"
  /**
   * The server named a wait longer than this caller can accept. Not a
   * failure of the server's — it answered, and clearly. The wait is simply
   * longer than the caller has to give, so the request ends here and the
   * number it asked for travels back with the refusal.
   */
  | "retry_after_too_long";

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
  | {
      retry: false;
      reason: RetryRefusal;
      /**
       * What the server asked us to wait, in milliseconds, when it named a
       * figure we could not accept. Present only with
       * `retry_after_too_long`, and present so the caller can say "the
       * service asked for 20 seconds" rather than a bare failure.
       */
      retryAfterMs?: number;
    }
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
  /**
   * The wait the response asked for, ALREADY PARSED, or null when it named
   * none or named one that cannot be used.
   *
   * Parsed by the caller rather than here because the guarded handle exposes
   * the same figure, and the header's date form is relative to a clock: two
   * parses a few hundred milliseconds apart disagree, one of them returning
   * null once the named instant has passed. One parse, one answer.
   */
  retryAfterMs?: number | null;
  /**
   * Caller-owned fact: delivering this exact request again produces no
   * additional side effects.
   */
  replaySafe: boolean;
  /**
   * Whether the request body can physically be delivered a second time.
   *
   * Transport-owned, unlike `replaySafe`: a one-shot source (a stream) is
   * consumed by the first attempt, and handing the spent source back to fetch
   * rejects with a TypeError about a disturbed body — which then looks like a
   * network failure and gets replayed again, so the caller ends up holding
   * that TypeError instead of the status the server actually sent.
   *
   * Defaults to true, which is right for every body that is not a stream and
   * for a request with no body at all.
   */
  bodyReplayable?: boolean;
  /**
   * Caller-owned fact: someone is waiting on this request right now.
   *
   * Like `replaySafe`, a statement about the caller's situation rather than
   * a preference about retrying. It selects how long a server-directed wait
   * may be before the wait is worse than the failure — the two ceilings in
   * `constants.ts`. Defaults to false: a worker or a job has nobody waiting,
   * which is the common case in this codebase.
   */
  interactive?: boolean;
  /** 1-based attempt counter (1 = the first retry being considered). */
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
 * Parse a `Retry-After` value into the wait it names, in milliseconds.
 *
 * Accepts delay-seconds and IMF-fixdate, rejecting everything else so a
 * malformed header falls back to our own backoff rather than to zero. Note
 * `Number("")` and `Number("  ")` are both `0` rather than `NaN`, so a
 * digits-only pattern does the validation instead of a numeric cast.
 * @param raw - The raw header value, if the response carried one.
 * @param nowMs - Current epoch milliseconds, for the HTTP-date form.
 * @returns The wait the server asked for, verbatim, or null when it named none we can read.
 */
export function parseRetryAfter(
  raw: string | null | undefined,
  nowMs: number,
): number | null {
  if (raw == null) return null;
  const value = raw.trim();

  if (/^\d+$/.test(value)) {
    return Number(value) * 1000;
  }

  if (!IMF_FIXDATE.test(value)) return null;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  const wait = at - nowMs;
  // A date already past carries no usable instruction — it describes a moment
  // that has gone, whether through clock skew or a cached response. Flooring it
  // to zero turned the polite path into the impolite one: three attempts with
  // no gap between them, which is the opposite of what honouring Retry-After is
  // for. With no usable instruction we are back to estimating for ourselves,
  // exactly as when the server said nothing. An explicit `Retry-After: 0` is
  // different and is still honoured: that is an instruction, not a stale one.
  return wait > 0 ? wait : null;
}

/**
 * How long to wait before the authorized replay: the server's
 * `Retry-After` when it gave a usable one, otherwise our own
 * full-jittered exponential backoff.
 * @param input - The same input the decision was made from.
 * @returns The wait in milliseconds.
 */
function serverDirectedWaitMs(input: RetryInput): number | null {
  // A transport error means no response existed, so no header could have
  // arrived — ignore any value a caller passed alongside it.
  if (input.transportError !== undefined) return null;
  return input.retryAfterMs ?? null;
}

/**
 * Our own guess at how long to wait, for when the server named nothing.
 *
 * This is the only place a number we invented is allowed. It exists because
 * a dropped connection or a silent timeout tells us nothing about when the
 * far side will be well again, so somebody has to estimate — and full-jittered
 * exponential backoff is the standard estimate. The moment the server DOES
 * name a figure, that figure wins: it knows its own recovery timeline and we
 * do not.
 * @param input - The decision input, for the attempt counter and jitter source.
 * @returns The estimated wait in milliseconds.
 */
function ownBackoffMs(input: RetryInput): number {
  // `attempt` is 1-based; the backoff helper is 0-based.
  return exponentialJitterDelay(input.attempt - 1, BASE_DELAY_MS, input.rand);
}

/**
 * The longest server-directed wait this caller can accept.
 * @param input - The decision input, for the caller's `interactive` statement.
 * @returns The ceiling in milliseconds.
 */
function waitCeilingMs(input: RetryInput): number {
  return input.interactive === true
    ? MAX_RETRY_AFTER_INTERACTIVE_MS
    : MAX_RETRY_AFTER_BACKGROUND_MS;
}

/**
 * Turn a would-be retry into a decision, honouring the server's own figure
 * and refusing outright when that figure is longer than the caller can give.
 *
 * The refusal is the point. There are exactly two things to do with a wait
 * that is too long — serve it, or stop — because this system has no queue to
 * defer work into: every operation ends completed or failed. Shortening the
 * server's figure to something we find convenient is not a third option; it
 * disregards the only party that knows when it will be ready, and still makes
 * someone wait.
 * @param input - The decision input.
 * @param reason - Why this was going to be retried.
 * @returns A retry carrying the wait, or a refusal carrying what was asked.
 */
function scheduleRetry(input: RetryInput, reason: RetryTrigger): RetryDecision {
  const asked = serverDirectedWaitMs(input);
  if (asked === null) return { retry: true, reason, delayMs: ownBackoffMs(input) };
  if (asked > waitCeilingMs(input)) {
    return { retry: false, reason: "retry_after_too_long", retryAfterMs: asked };
  }
  return { retry: true, reason, delayMs: asked };
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

  // ── Platform semantics: not "should we replay" but "can we" ──
  // Ahead of everything about status, because no status changes it. 429 and
  // 408 retry unconditionally on the grounds that the server never processed
  // the request — which answers what a replay would COST, and says nothing
  // about whether one can happen at all. A stream body was consumed by the
  // first attempt; handing the spent source back to fetch rejects with a
  // TypeError about a disturbed body, and that TypeError then replaces the
  // status the server actually sent.
  //
  // This sits with `caller_aborted` and `fatal_error` rather than with
  // `replaySafe` because it is the same kind of fact as those two: an
  // absolute, not a judgement about consequences.
  if (input.bodyReplayable === false) {
    return { retry: false, reason: "body_not_replayable" };
  }

  // Budget before failure kind, so telemetry distinguishes "gave up after
  // trying" from "refused to try".
  if (input.attempt > MAX_RETRIES) {
    return { retry: false, reason: "attempts_exhausted" };
  }

  const { status } = input;

  // ── Protocol semantics: true regardless of what the request does ──
  if (status === 429) {
    return scheduleRetry(input, "rate_limited");
  }
  if (status === 408) {
    return scheduleRetry(input, "request_timeout");
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return { retry: false, reason: "client_error" };
  }

  // Is this a failure at all? A 3xx the transport does not follow — a 304, or
  // a redirect an SSRF guard returns unfollowed — is not ok, so it reaches
  // here, and answering with the caller's side-effect declaration blamed that
  // declaration for a response that never failed. An on-call engineer reading
  // "not_replay_safe, status 304" goes looking for a bug that is not there.
  const failed =
    (input.status !== undefined && input.status >= 500) ||
    input.transportError !== undefined;
  if (!failed) {
    return { retry: false, reason: "nothing_to_retry" };
  }

  // ── Application semantics: only the caller knows this ──
  if (!input.replaySafe) {
    return { retry: false, reason: "not_replay_safe" };
  }

  if (status !== undefined && status >= 500) {
    return scheduleRetry(input, "server_error");
  }
  if (input.transportError === "network") {
    return scheduleRetry(input, "network_error");
  }
  if (input.transportError === "timeout") {
    return scheduleRetry(input, "attempt_timeout");
  }

  // Every failure kind above is handled; this is the arm no known input
  // reaches, kept so the function is total rather than throwing at runtime.
  return { retry: false, reason: "nothing_to_retry" };
}
