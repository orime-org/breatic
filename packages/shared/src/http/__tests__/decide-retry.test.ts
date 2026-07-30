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

import { decideRetry } from "@shared/http/decide-retry.js";
import { MAX_RETRIES, BASE_DELAY_MS, MAX_RETRY_AFTER_MS } from "@shared/http/constants.js";

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
    expect(d).toMatchObject({ retry: true, reason: "rate_limited" });
  });

  it("retries 408 even when replaying is not safe", () => {
    // 408 = the server gave up reading our request, so it never ran it.
    const d = decideRetry({ ...base, status: 408, replaySafe: false });
    expect(d).toMatchObject({ retry: true, reason: "request_timeout" });
  });

  it.each([400, 401, 403, 404, 409, 422])(
    "refuses %i as a client error even when replaying is safe",
    (status) => {
      const d = decideRetry({ ...base, status, replaySafe: true });
      expect(d).toEqual({ retry: false, reason: "client_error" });
    },
  );

  it("refuses a caller abort ahead of everything else", () => {
    // The user pressed stop. No status, no replaySafe value, and no
    // remaining attempt budget may resurrect the request.
    const d = decideRetry({
      ...base,
      transportError: "caller_aborted",
      replaySafe: true,
    });
    expect(d).toEqual({ retry: false, reason: "caller_aborted" });
  });

  it("refuses when neither a failing status nor a transport error is present", () => {
    const d = decideRetry({ ...base, status: 200 });
    expect(d).toEqual({ retry: false, reason: "nothing_to_retry" });
  });
});

describe("decideRetry — application semantics the caller owns", () => {
  it.each([500, 502, 503, 504])("retries %i when replaying is safe", (status) => {
    const d = decideRetry({ ...base, status, replaySafe: true });
    expect(d).toMatchObject({ retry: true, reason: "server_error" });
  });

  it.each([500, 502, 503, 504])(
    "refuses %i when replaying is NOT safe (guards duplicate vendor cost)",
    (status) => {
      // This is the branch that preserves the 2026-07-07 decision: an AIGC
      // submit that failed with a 5xx may already be generating upstream.
      const d = decideRetry({ ...base, status, replaySafe: false });
      expect(d).toEqual({ retry: false, reason: "not_replay_safe" });
    },
  );

  it("retries a network error when replaying is safe", () => {
    const d = decideRetry({ ...base, transportError: "network" });
    expect(d).toMatchObject({ retry: true, reason: "network_error" });
  });

  it("refuses a network error when replaying is not safe", () => {
    // A dropped connection is the ambiguous case: the request may well
    // have arrived and be running. Non-replayable means we do not gamble.
    const d = decideRetry({
      ...base,
      transportError: "network",
      replaySafe: false,
    });
    expect(d).toEqual({ retry: false, reason: "not_replay_safe" });
  });

  it("retries an attempt timeout when replaying is safe", () => {
    const d = decideRetry({ ...base, transportError: "timeout" });
    expect(d).toMatchObject({ retry: true, reason: "attempt_timeout" });
  });

  it("refuses an attempt timeout when replaying is not safe", () => {
    const d = decideRetry({
      ...base,
      transportError: "timeout",
      replaySafe: false,
    });
    expect(d).toEqual({ retry: false, reason: "not_replay_safe" });
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
    expect(d).toEqual({ retry: false, reason: "attempts_exhausted" });
  });

  it("reports exhaustion rather than the failure kind once the budget is spent", () => {
    // Even a 429 — normally the most retryable case — must report
    // exhaustion, so telemetry distinguishes "gave up" from "refused".
    const d = decideRetry({ ...base, status: 429, attempt: MAX_RETRIES + 1 });
    expect(d).toEqual({ retry: false, reason: "attempts_exhausted" });
  });

  it("puts caller abort ahead of exhaustion", () => {
    const d = decideRetry({
      ...base,
      transportError: "caller_aborted",
      attempt: MAX_RETRIES + 5,
    });
    expect(d).toEqual({ retry: false, reason: "caller_aborted" });
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
    const d = decideRetry({ ...base, status: 429, retryAfter: "3" });
    expect(d).toMatchObject({ retry: true, delayMs: 3000 });
  });

  it("uses an HTTP-date Retry-After, measured against the injected clock", () => {
    const target = new Date(NOW + 4000).toUTCString();
    const d = decideRetry({ ...base, status: 429, retryAfter: target });
    // toUTCString() truncates to whole seconds, so allow a sub-second skew.
    expect(d.retry).toBe(true);
    if (d.retry) {
      expect(d.delayMs).toBeGreaterThanOrEqual(3000);
      expect(d.delayMs).toBeLessThanOrEqual(4000);
    }
  });

  it("clamps a hostile Retry-After to MAX_RETRY_AFTER_MS", () => {
    const d = decideRetry({ ...base, status: 429, retryAfter: "86400" });
    expect(d).toMatchObject({ retry: true, delayMs: MAX_RETRY_AFTER_MS });
  });

  it("treats a past HTTP-date Retry-After as no delay, never negative", () => {
    const past = new Date(NOW - 60_000).toUTCString();
    const d = decideRetry({ ...base, status: 429, retryAfter: past });
    expect(d).toMatchObject({ retry: true, delayMs: 0 });
  });

  it.each(["", "   ", "soon", "-5", "NaN", "3.5.1"])(
    "falls back to the jittered backoff for the malformed Retry-After %o",
    (retryAfter) => {
      const d = decideRetry({ ...base, status: 429, retryAfter, attempt: 1 });
      expect(d).toMatchObject({ retry: true, delayMs: BASE_DELAY_MS });
    },
  );

  it("ignores Retry-After on a transport error (no response carried one)", () => {
    const d = decideRetry({ ...base, transportError: "network", retryAfter: "30" });
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
      now,
    });
    expect(d.retry).toBe(true);
    if (d.retry) {
      expect(d.delayMs).toBeGreaterThanOrEqual(0);
      expect(d.delayMs).toBeLessThanOrEqual(BASE_DELAY_MS);
    }
  });
});
