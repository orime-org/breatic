// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from "vitest";

import { fullJitter, exponentialJitterDelay } from "@shared/backoff.js";

/**
 * fullJitter is the "retry with exponential backoff AND jitter" primitive
 * (#1625 Slice 2). Callers compute their own exponential ceiling and hand it here;
 * fullJitter picks a uniformly random delay in [0, ceiling] so correlated failures
 * do not retry in synchronized waves (thundering herd). The rand source is
 * injectable so these assertions are deterministic.
 */
describe("fullJitter", () => {
  it("returns 0 when rand() is 0", () => {
    expect(fullJitter(1000, () => 0)).toBe(0);
  });

  it("returns the full ceiling when rand() is 1", () => {
    expect(fullJitter(1000, () => 1)).toBe(1000);
  });

  it("scales linearly with rand()", () => {
    expect(fullJitter(1000, () => 0.5)).toBe(500);
    expect(fullJitter(800, () => 0.25)).toBe(200);
  });

  it("rounds to an integer millisecond", () => {
    expect(fullJitter(1000, () => 0.3337)).toBe(334);
  });

  it("INVARIANT: never negative, never exceeds the ceiling", () => {
    for (const r of [0, 0.001, 0.5, 0.999, 1]) {
      const d = fullJitter(2000, () => r);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(2000);
    }
  });

  it("clamps a non-positive ceiling to 0 (defensive — no negative delay)", () => {
    expect(fullJitter(0, () => 0.9)).toBe(0);
    expect(fullJitter(-100, () => 0.9)).toBe(0);
  });

  it("defaults rand to Math.random and stays within bounds", () => {
    const d = fullJitter(500);
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThanOrEqual(500);
  });
});

/**
 * exponentialJitterDelay is the 0-based-attempt form. It backs the shared HTTP
 * transport's between-attempt wait (`http/decide-retry.ts`, which counts replays
 * 1-based and subtracts one) and the browser upload retry.
 */
describe("exponentialJitterDelay (0-based attempt)", () => {
  it("ceiling doubles per attempt; rand=1 hits the ceiling exactly", () => {
    expect(exponentialJitterDelay(0, 2000, () => 1)).toBe(2000); // 2^0
    expect(exponentialJitterDelay(1, 2000, () => 1)).toBe(4000); // 2^1
    expect(exponentialJitterDelay(2, 2000, () => 1)).toBe(8000); // 2^2
  });

  it("rand=0 yields 0 at every attempt", () => {
    expect(exponentialJitterDelay(0, 2000, () => 0)).toBe(0);
    expect(exponentialJitterDelay(3, 2000, () => 0)).toBe(0);
  });

  it("INVARIANT: delay in [0, base*2^attempt]", () => {
    for (const a of [0, 1, 2, 3]) {
      const ceil = 2000 * 2 ** a;
      const d = exponentialJitterDelay(a, 2000, () => 0.5);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(ceil);
    }
  });
});

describe("fullJitter — the guard on its ceiling", () => {
  it.each([Number.NaN, -1, -0.5, 0])("clamps the unusable ceiling %o to zero", (ceiling) => {
    // The guard is written `if (!(ceilingMs > 0)) return 0`, and the negation
    // is what makes it cover NaN — every comparison against NaN is false, so
    // `ceilingMs <= 0` would have let a NaN through to `Math.round(rand() *
    // NaN)`, i.e. a NaN delay handed to `setTimeout`, which fires immediately.
    // Measured by mutation, that half of the guard could be flipped with the
    // whole suite still green.
    expect(fullJitter(ceiling)).toBe(0);
  });

  it("never exceeds the ceiling it was given", () => {
    // The property, not one sample: the whole reason for jitter is that the
    // delay is random, so an assertion on one value proves nothing.
    for (const r of [0, 0.25, 0.5, 0.75, 0.999999]) {
      expect(fullJitter(1_000, () => r)).toBeLessThanOrEqual(1_000);
      expect(fullJitter(1_000, () => r)).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns whole milliseconds", () => {
    // `setTimeout` truncates a fractional delay, so a non-integer here would
    // mean the delay reported in telemetry is not the delay actually taken.
    expect(Number.isInteger(fullJitter(1_000, () => 0.333333))).toBe(true);
  });
});
