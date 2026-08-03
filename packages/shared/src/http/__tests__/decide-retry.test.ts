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
 * The ordering between those two is load-bearing and is asserted here: a
 * rate-limited non-replayable submit must still back off and retry, because
 * 429 is the one case where the server has told us nothing happened. Getting
 * this backwards fails the request outright in exactly the situation that most
 * deserves patience.
 *
 * A third kind sits above both and is asserted in its own block: whether the
 * body can physically go out again. No status changes that, so it is answered
 * first — and 429 is the only status that can prove it, being the one that
 * would otherwise say yes regardless.
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

/** The same instant as an HTTP-date, five seconds out. */
const inFiveSeconds = new Date(NOW + 5000).toUTCString();

/** Baseline input: a replay-safe first retry, so each case varies one thing. */
const base = {
  replaySafe: true,
  attempt: 1,
  rand: () => 1, // max jitter → deterministic ceiling
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

  it.each([600, 700, 999])(
    "refuses %i: there is no status class above 5xx",
    (status) => {
      // The upper bound of the server-error range, asserted. `status >= 500`
      // on its own treats anything above 599 as a retryable server error, and
      // a raw socket really can answer "HTTP/1.1 600" — measured: fetch
      // surfaces it as an ordinary response rather than refusing it.
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

  // These two used to be four: the same two calls again under the names
  // "network error" and "attempt timeout". `RetryInput` carries no term for
  // WHICH failure — it was removed because every kind was answered the same
  // way — so the two extra names promised a distinction the input cannot
  // express and the assertions could not have told apart. The distinction is
  // exercised where it is real: real-fetch.test.ts drives a silent server and
  // a destroyed socket against the actual loop.
  it("retries when no response arrived at all and replaying is safe", () => {
    const d = decideRetry({ ...base });
    expect(d).toMatchObject({ retry: true });
  });

  it("refuses when no response arrived and replaying is not safe", () => {
    // The ambiguous case: the request may well have arrived and be running.
    // Non-replayable means we do not gamble.
    const d = decideRetry({ ...base, replaySafe: false });
    expect(d).toEqual({ retry: false });
  });
});

describe("decideRetry — a spent body outranks every status", () => {
  it("refuses a 429 when the body cannot be sent again", () => {
    // The ordering the module docstring calls load-bearing, asserted rather
    // than asserted-in-a-comment: 429 is the ONE status that authorises a
    // replay regardless of what the caller declared, so it is the only status
    // that can prove the body check runs first. Move that check below the
    // 429 branch and this is the test that goes red.
    const d = decideRetry({
      ...base,
      status: 429,
      replaySafe: false,
      bodyReplayable: false,
    });
    expect(d).toEqual({ retry: false });
  });

  it("refuses a 408 when the body cannot be sent again", () => {
    const d = decideRetry({ ...base, status: 408, bodyReplayable: false });
    expect(d).toEqual({ retry: false });
  });

  it("refuses a transport failure when the body cannot be sent again", () => {
    const d = decideRetry({ ...base, bodyReplayable: false });
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

  it("spends the budget even on a 429, the most retryable status there is", () => {
    // The budget outranks protocol semantics. The comment here used to say
    // this let telemetry tell "gave up" apart from "refused" — it cannot, and
    // deliberately so: `RetryDecision` is `{ retry: false }` either way, and
    // an earlier cut that carried the reason found the loop never read it.
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

  it("ignores a Retry-After handed in beside an absent status", () => {
    // No response means no header could have arrived, so a figure passed
    // alongside that absence is not the server's and must not be believed.
    // The wait a believed one would produce is far from the backoff, so
    // deleting the guard shows up here rather than hiding inside jitter.
    const d = decideRetry({ ...base, retryAfterMs: 55_000 });
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

describe("parseRetryAfter — the same rule for both forms the header allows", () => {
  it.each([
    ["delay-seconds", "5"],
    ["HTTP-date", inFiveSeconds],
  ])("reads a single %s value", (_form, raw) => {
    expect(parseRetryAfter(raw, NOW)).toBe(5000);
  });

  it.each([
    ["delay-seconds", "5, 5"],
    ["HTTP-date", `${inFiveSeconds}, ${inFiveSeconds}`],
  ])("honours a %s value the server sent twice", (_form, raw) => {
    // `Headers.get` joins a repeated field with a comma, so a server that
    // sent Retry-After twice arrives here as one string. Retry-After is a
    // singleton field and a repeat is malformed — but when every copy says
    // the same thing the instruction is unambiguous, and rejecting it drops
    // us to sub-second jitter against the very server that asked for room.
    //
    // The date form is why this is one rule and not two: IMF-fixdate carries
    // a comma of its own ("Thu, 30 Jul…"), so splitting on commas could never
    // collapse a repeated date, and for months only the seconds form worked.
    expect(parseRetryAfter(raw, NOW)).toBe(5000);
  });

  it("reads what a real Headers object produces from a repeated date field", () => {
    // Not a hand-built string: the platform's own joining, which is the only
    // way this input reaches the parser in production.
    const headers = new Headers();
    headers.append("retry-after", inFiveSeconds);
    headers.append("retry-after", inFiveSeconds);
    expect(parseRetryAfter(headers.get("retry-after"), NOW)).toBe(5000);
  });

  it.each([
    ["delay-seconds", "5, 7"],
    ["HTTP-date", `${inFiveSeconds}, ${new Date(NOW + 9000).toUTCString()}`],
  ])("refuses a repeated %s whose copies disagree", (_form, raw) => {
    // Two different instructions are no instruction. Falling back to our own
    // backoff is the honest answer; picking one of them would be a guess.
    expect(parseRetryAfter(raw, NOW)).toBeNull();
  });

  it.each([
    ["a non-GMT zone", "Thu, 30 Jul 2026 12:00:05 UTC"],
    ["a lower-case zone", "Thu, 30 Jul 2026 12:00:05 gmt"],
  ])("refuses an HTTP-date with %s", (_why, raw) => {
    // Both are accepted by `Date.parse` — measured, each yields exactly
    // NOW + 5s — and both must still be refused, because RFC 9110 §5.6.7
    // admits one form and a wait we invented from an illegal string is a wait
    // nobody sent.
    //
    // What refuses them is the round trip in `datesBackToItself`, not the
    // shape regex: `toUTCString` always re-emits `GMT`, so neither string can
    // equal what it parsed to. This comment used to credit the shape gate,
    // which is why it is worth naming — loosening that regex leaves this test
    // green, and someone chasing the wrong line would have found nothing.
    expect(parseRetryAfter(raw, NOW)).toBeNull();
  });

  it.each([
    ["a day that does not exist", "Tue, 31 Feb 2027 12:00:00 GMT"],
    ["a weekday that is not that date's weekday", "Mon, 30 Jul 2026 12:00:05 GMT"],
    ["a seconds field past 59", "Thu, 30 Jul 2026 12:05:99 GMT"],
    ["a seconds field of exactly 60", "Thu, 30 Jul 2026 12:05:60 GMT"],
  ])("refuses an HTTP-date naming %s", (_why, raw) => {
    // Every one of these is shaped correctly and `Date.parse` accepts every
    // one — it rolls, ignores or truncates rather than refusing:
    //
    //   31 Feb 2027   -> 3 Mar 2027   (rolled: a wait of seven months)
    //   Mon 30 Jul    -> that Thursday (weekday token ignored entirely)
    //   12:05:99      -> 12:05:00     (truncated: five minutes, not 99s)
    //
    // The last one is the sharpest: the server asked for a wait the layer
    // then rewrites into a different one, so it is not a wait anybody sent.
    expect(parseRetryAfter(raw, NOW)).toBeNull();
  });

  it("is not fooled by a value repeated thousands of times", () => {
    // The repeat rule is matched with a back-reference, so this pins that a
    // hostile header cannot make it expensive. Measured at 5000 copies plus a
    // non-matching tail: under a millisecond.
    const hostile = `${Array.from({ length: 5000 }, () => "5").join(", ")}, x`;
    const started = performance.now();
    expect(parseRetryAfter(hostile, NOW)).toBeNull();
    expect(performance.now() - started).toBeLessThan(100);
  });
});
