// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The retry backoff of the refund loop (inner#1410 §7.1, §7.4).
 *
 * A disposition in `started` gives up (E11, `attempts_exhausted`) once its
 * attempt count reaches `max_attempts`, shipped as 8. The delay between
 * retries is core's `nextAttemptDelaySeconds`.
 */

import { describe, it, expect } from "vitest";
import { attemptsExhausted } from "@server/modules/credit-refund/backoff.js";

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
