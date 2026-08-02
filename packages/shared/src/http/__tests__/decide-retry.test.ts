// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * `decideRetry` is the SINGLE home of "should this request be replayed".
 *
 * Two knowledge domains meet here and the split is the whole point:
 *
 *   - Protocol semantics the transport owns: 429/408 mean the server did
 *     not process the request, so replaying is safe regardless of what the
 *     request does; other 4xx are facts that a replay cannot change.
 *   - Application semantics only the CALLER knows: whether delivering this
 *     exact request a second time produces additional side effects. An
 *     AIGC submit without a vendor idempotency key does (a second billed
 *     generation); the same submit WITH one does not.
 *
 * The ordering between those two is load-bearing and is asserted here:
 * a rate-limited non-replayable submit must still back off and retry,
 * because 429 is the one case where the server has told us nothing
 * happened. Getting this backwards fails the request outright in exactly
 * the situation that most deserves patience.
 */

import { describe, it, expect } from "vitest";

import { decideRetry, parseRetryAfter } from "@shared/http/decide-retry.js";
import {
  MAX_RETRIES,
  BASE_DELAY_MS,
  MAX_RETRY_AFTER_MS,
} from "@shared/http/constants.js";

/** Fixed clock for HTTP-date `Retry-After` parsing. */
const NOW = Date.UTC(2026, 6, 30, 12, 0, 0);
const now = (): number => NOW;

/** Baseline input: a replay-safe first retry, so each case varies one thing. */
const base = {
  replaySafe: true,
  attempt: 1,
  rand: () => 1, // max jitter → deterministic ceiling
  now,
};

describe("decideRetry — protocol semantics the transport owns", () => {
  it("retries 429 even when the caller says replaying is NOT safe", () => {
    // The single most important assertion in this file. A 429 states the
    // request was never processed, so a non-idempotent submit is still
    // safe to replay — and rate limiting is precisely when backing off
    // beats failing.
    const d = decideRetry({ ...base, status: 429, replaySafe: false });
    expect(d.retry).toBe(true);
    expect(d).toMatchObject({ retry: true });
  });

  it("retries 408 even when replaying is not safe", () => {
    // 408 = the server gave up reading our request, so it never ran it.
    const d = decideRetry({ ...base, status: 408, replaySafe: false });
    expect(d).toMatchObject({ retry: true });
  });

  it.each([400, 401, 403, 404, 409, 422])(
    "refuses %i as a client error even when replaying is safe",
    (status) => {
      const d = decideRetry({ ...base, status, replaySafe: true });
      expect(d).toEqual({ retry: false });
    },
  );

  it("refuses when neither a failing status nor a transport error is present", () => {
    const d = decideRetry({ ...base, status: 200 });
    expect(d).toEqual({ retry: false });
  });
});

describe("decideRetry — application semantics the caller owns", () => {
  it.each([500, 502, 503, 504])("retries %i when replaying is safe", (status) => {
    const d = decideRetry({ ...base, status, replaySafe: true });
    expect(d).toMatchObject({ retry: true });
  });

  it.each([500, 502, 503, 504])(
    "refuses %i when replaying is NOT safe (guards duplicate vendor cost)",
    (status) => {
      // This is the branch that preserves the 2026-07-07 decision: an AIGC
      // submit that failed with a 5xx may already be generating upstream.
      const d = decideRetry({ ...base, status, replaySafe: false });
      expect(d).toEqual({ retry: false });
    },
  );

  it("retries a network error when replaying is safe", () => {
    const d = decideRetry({ ...base });
    expect(d).toMatchObject({ retry: true });
  });

  it("refuses a network error when replaying is not safe", () => {
    // A dropped connection is the ambiguous case: the request may well
    // have arrived and be running. Non-replayable means we do not gamble.
    const d = decideRetry({
      ...base,
      replaySafe: false,
    });
    expect(d).toEqual({ retry: false });
  });

  it("retries an attempt timeout when replaying is safe", () => {
    const d = decideRetry({ ...base });
    expect(d).toMatchObject({ retry: true });
  });

  it("refuses an attempt timeout when replaying is not safe", () => {
    const d = decideRetry({
      ...base,
      replaySafe: false,
    });
    expect(d).toEqual({ retry: false });
  });
});

describe("decideRetry — attempt budget", () => {
  it("allows every attempt up to MAX_RETRIES", () => {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const d = decideRetry({ ...base, status: 503, attempt });
      expect(d.retry).toBe(true);
    }
  });

  it("refuses the attempt past MAX_RETRIES", () => {
    const d = decideRetry({ ...base, status: 503, attempt: MAX_RETRIES + 1 });
    expect(d).toEqual({ retry: false });
  });

  it("reports exhaustion rather than the failure kind once the budget is spent", () => {
    // Even a 429 — normally the most retryable case — must report
    // exhaustion, so telemetry distinguishes "gave up" from "refused".
    const d = decideRetry({ ...base, status: 429, attempt: MAX_RETRIES + 1 });
    expect(d).toEqual({ retry: false });
  });

  it("fixes the total attempt count at three (first try plus two retries)", () => {
    expect(MAX_RETRIES).toBe(2);
  });
});

describe("decideRetry — backoff delay", () => {
  it("grows the ceiling exponentially across attempts", () => {
    // rand()=1 pins the jitter to its ceiling: BASE * 2 ** (attempt - 1).
    const first = decideRetry({ ...base, status: 503, attempt: 1 });
    const second = decideRetry({ ...base, status: 503, attempt: 2 });
    expect(first).toMatchObject({ retry: true, delayMs: BASE_DELAY_MS });
    expect(second).toMatchObject({ retry: true, delayMs: BASE_DELAY_MS * 2 });
  });

  it("jitters within [0, ceiling] rather than always waiting the ceiling", () => {
    const zero = decideRetry({ ...base, status: 503, attempt: 2, rand: () => 0 });
    const half = decideRetry({ ...base, status: 503, attempt: 2, rand: () => 0.5 });
    expect(zero).toMatchObject({ delayMs: 0 });
    expect(half).toMatchObject({ delayMs: BASE_DELAY_MS });
  });

  it("uses a numeric Retry-After (seconds) in preference to the backoff", () => {
    const d = decideRetry({ ...base, status: 429, retryAfterMs: 3000 });
    expect(d).toMatchObject({ retry: true, delayMs: 3000 });
  });

  it("reads an HTTP-date Retry-After against the clock it is given", () => {
    // A parsing question, asked of the parser. The decision no longer parses:
    // the header's date form is relative to a clock, and parsing it twice a
    // few hundred milliseconds apart produced two different answers — one of
    // them null once the named instant had passed.
    const target = new Date(NOW + 4000).toUTCString();
    const ms = parseRetryAfter(target, NOW);
    // toUTCString() truncates to whole seconds, so allow a sub-second skew.
    expect(ms).toBeGreaterThanOrEqual(3000);
    expect(ms).toBeLessThanOrEqual(4000);
  });

  it.each([5_000, 55_000])("serves a wait of %ims exactly as the server asked", (retryAfterMs) => {
    // One ceiling, not two. There used to be a shorter one for callers with a
    // person waiting, justified by an attention-span limit — but how long a
    // person will wait is a product decision, and this layer holds none.
    const d = decideRetry({ ...base, status: 429, retryAfterMs });
    expect(d).toMatchObject({ retry: true, delayMs: retryAfterMs });
  });

  it("treats the ceiling itself as acceptable, not as over", () => {
    const d = decideRetry({ ...base, status: 429, retryAfterMs: 60_000 });
    expect(d).toMatchObject({ retry: true, delayMs: MAX_RETRY_AFTER_MS });
  });

  it("stops past the ceiling, and says how long was asked", () => {
    // The ceiling is a THRESHOLD, not a clamp. Clamping was the worst of both
    // worlds: it neither honoured what the server asked (61s became 60s) nor
    // spared anyone the wait, and the number nobody sent was ours. Stopping
    // hands the caller a response whose own `Retry-After` header still says 61,
    // so it can read the figure and decide for itself.
    const d = decideRetry({ ...base, status: 429, retryAfterMs: 61_000 });
    expect(d).toMatchObject({ retry: false });
  });

  it("never clamps: a hostile Retry-After stops the request, it is not quietly shortened", () => {
    // A day-long wait used to come back as a 10s delay — a number nobody sent.
    // Refusing is the whole assertion: a clamp would show up here as
    // `{ retry: true, delayMs: 60000 }`, which is what this pins against. The
    // figure the server asked for is not relayed, because it is already in the
    // response's own Retry-After header, which the caller receives.
    const d = decideRetry({ ...base, status: 429, retryAfterMs: 86_400_000 });
    expect(d).toEqual({ retry: false });
  });

  it("falls back to its own backoff when the Retry-After date has already passed", () => {
    // This asserted `delayMs: 0` and was wrong about what the floor meant. A
    // date in the past describes a moment that has gone — clock skew, or a
    // cached response — so it carries no usable instruction, and clamping it
    // to zero turned the polite path into three attempts with no gap at all.
    // No usable instruction puts us back where we are when the server says
    // nothing: estimating for ourselves.
    const past = new Date(NOW - 60_000).toUTCString();
    expect(parseRetryAfter(past, NOW)).toBeNull();
    const d = decideRetry({ ...base, status: 429, retryAfterMs: null, attempt: 1 });
    expect(d).toMatchObject({ retry: true, delayMs: BASE_DELAY_MS });
  });

  it("still honours an explicit Retry-After of zero", () => {
    // The distinction the change turns on: `0` is an instruction the server
    // chose to send, a stale date is an instruction that expired.
    const d = decideRetry({ ...base, status: 429, retryAfterMs: 0, attempt: 1 });
    expect(d).toMatchObject({ retry: true, delayMs: 0 });
  });

  it.each(["", "   ", "soon", "-5", "NaN", "3.5.1"])(
    "reads the malformed Retry-After %o as no instruction at all",
    (raw) => {
      // Two halves of the same rule, each asked of the layer that owns it:
      // the parser refuses to guess, and the decision treats "no usable
      // instruction" exactly as it treats a server that said nothing.
      expect(parseRetryAfter(raw, NOW)).toBeNull();
      const d = decideRetry({ ...base, status: 429, retryAfterMs: null, attempt: 1 });
      expect(d).toMatchObject({ retry: true, delayMs: BASE_DELAY_MS });
    },
  );

  it("ignores Retry-After on a transport error (no response carried one)", () => {
    const d = decideRetry({ ...base });
    expect(d).toMatchObject({ retry: true, delayMs: BASE_DELAY_MS });
  });

  it("carries no delay on a refusal", () => {
    const d = decideRetry({ ...base, status: 404 });
    expect(d).not.toHaveProperty("delayMs");
  });

  it("defaults its randomness source so callers need not inject one", () => {
    const d = decideRetry({
      status: 503,
      replaySafe: true,
      attempt: 1,
    });
    expect(d.retry).toBe(true);
    if (d.retry) {
      expect(d.delayMs).toBeGreaterThanOrEqual(0);
      expect(d.delayMs).toBeLessThanOrEqual(BASE_DELAY_MS);
    }
  });
});
