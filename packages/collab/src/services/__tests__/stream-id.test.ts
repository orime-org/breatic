// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { isNewerStreamId, retryDelayMs } from "@collab/services/stream-id.js";

describe("isNewerStreamId", () => {
  it("compares the millisecond part numerically, not as text", () => {
    expect(isNewerStreamId("10000-0", "9999-5")).toBe(true);
    expect(isNewerStreamId("9999-5", "10000-0")).toBe(false);
  });

  it("falls back to the sequence part when the milliseconds match", () => {
    expect(isNewerStreamId("1700-10", "1700-9")).toBe(true);
    expect(isNewerStreamId("1700-9", "1700-10")).toBe(false);
  });

  it("is not newer than itself", () => {
    expect(isNewerStreamId("1700-3", "1700-3")).toBe(false);
  });

  it("treats anything as newer than a missing version", () => {
    expect(isNewerStreamId("0-1", undefined)).toBe(true);
  });

  it("treats a malformed held version as missing", () => {
    expect(isNewerStreamId("1700-1", "not-an-id")).toBe(true);
    expect(isNewerStreamId("1700-1", 42)).toBe(true);
  });

  it("orders every pair the way the integer pairs order", () => {
    fc.assert(
      fc.property(
        fc.tuple(fc.nat(), fc.nat()),
        fc.tuple(fc.nat(), fc.nat()),
        ([am, as], [bm, bs]) => {
          const expected = am > bm || (am === bm && as > bs);
          expect(isNewerStreamId(`${am}-${as}`, `${bm}-${bs}`)).toBe(expected);
        },
      ),
    );
  });
});

describe("retryDelayMs", () => {
  it("waits the minimum after the first failure and doubles after each next one", () => {
    expect(retryDelayMs(1, 10_000, 600_000)).toBe(10_000);
    expect(retryDelayMs(2, 10_000, 600_000)).toBe(20_000);
    expect(retryDelayMs(3, 10_000, 600_000)).toBe(40_000);
  });

  it("never waits longer than the maximum", () => {
    expect(retryDelayMs(10, 10_000, 600_000)).toBe(600_000);
    expect(retryDelayMs(500, 10_000, 600_000)).toBe(600_000);
  });
});
