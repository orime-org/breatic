// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from "vitest";

import { jitterBackoffStrategy } from "@core/infra/retry.js";

/**
 * jitterBackoffStrategy builds a BullMQ custom backoffStrategy. BullMQ passes a
 * 1-based `attemptsMade` (builtin exponential = 2^(attemptsMade-1)*delay), so
 * this off-by-one MUST match — it drives the credit-billing retry chain.
 *
 * The jitter arithmetic it delegates to is covered in
 * `packages/shared/src/__tests__/backoff.test.ts`; what is asserted here is the
 * 1-based-to-0-based adaptation, which is this module's whole reason to exist.
 */
describe("jitterBackoffStrategy (1-based attemptsMade — BullMQ)", () => {
  it("maps 1-based attemptsMade to 2^(attemptsMade-1)*base ceiling", () => {
    const strat = jitterBackoffStrategy(2000, () => 1);
    expect(strat(1)).toBe(2000); // 2^0 — first retry
    expect(strat(2)).toBe(4000); // 2^1
    expect(strat(3)).toBe(8000); // 2^2
  });

  it("rand=0 yields 0 — never a negative/undefined delay into the retry chain", () => {
    const strat = jitterBackoffStrategy(2000, () => 0);
    expect(strat(1)).toBe(0);
    expect(strat(5)).toBe(0);
  });
});
