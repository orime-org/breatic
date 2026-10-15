// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The retry backoff of the refund loop (inner#1410 §7.1, §7.4).
 *
 * The n-th retry waits `min(base * 2^(n-1), max)` seconds, and a disposition
 * in `started` gives up (E11, `attempts_exhausted`) once its attempt count
 * reaches `max_attempts`. The shipped numbers are 60 s, 3600 s and 8.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { attemptsExhausted, nextAttemptDelaySeconds } from "@server/modules/credit-refund/backoff.js";

const SHIPPED = { backoffBaseSeconds: 60, backoffMaxSeconds: 3600 };

describe("nextAttemptDelaySeconds", () => {
  it.each([
    [1, 60],
    [2, 120],
    [3, 240],
    [4, 480],
    [5, 960],
    [6, 1920],
    [7, 3600],
    [8, 3600],
  ])("attempt %i waits %i seconds with the shipped config", (attempt, seconds) => {
    expect(nextAttemptDelaySeconds(attempt, SHIPPED)).toBe(seconds);
  });

  it("caps at exactly the max when base * 2^(n-1) lands on it", () => {
    expect(nextAttemptDelaySeconds(3, { backoffBaseSeconds: 10, backoffMaxSeconds: 40 })).toBe(40);
    expect(nextAttemptDelaySeconds(4, { backoffBaseSeconds: 10, backoffMaxSeconds: 40 })).toBe(40);
  });

  it("returns the max, not Infinity or NaN, for an attempt count far past any config", () => {
    expect(nextAttemptDelaySeconds(2000, SHIPPED)).toBe(3600);
  });

  it("returns the max when the base already exceeds it", () => {
    expect(nextAttemptDelaySeconds(1, { backoffBaseSeconds: 500, backoffMaxSeconds: 300 })).toBe(300);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects attempt %s", (attempt) => {
    expect(() => nextAttemptDelaySeconds(attempt, SHIPPED)).toThrow(RangeError);
  });

  it("doubles until the cap and never exceeds it", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3600 }),
        fc.integer({ min: 1, max: 86_400 }),
        fc.integer({ min: 1, max: 64 }),
        (base, max, n) => {
          const cfg = { backoffBaseSeconds: base, backoffMaxSeconds: max };
          const d = nextAttemptDelaySeconds(n, cfg);
          const next = nextAttemptDelaySeconds(n + 1, cfg);
          expect(d).toBeLessThanOrEqual(max);
          expect(d).toBeGreaterThanOrEqual(Math.min(base, max));
          expect(next).toBe(Math.min(d * 2, max));
        },
      ),
    );
  });
});

describe("attemptsExhausted", () => {
  it.each([
    [0, false],
    [7, false],
    [8, true],
    [9, true],
  ])("attempt count %i of 8 → %s", (count, exhausted) => {
    expect(attemptsExhausted(count, { maxAttempts: 8 })).toBe(exhausted);
  });

  it("with max_attempts 1 the first counted attempt is the last", () => {
    expect(attemptsExhausted(0, { maxAttempts: 1 })).toBe(false);
    expect(attemptsExhausted(1, { maxAttempts: 1 })).toBe(true);
  });
});
