// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";

import { retryDelayMs } from "@collab/services/stream-group-consumer.js";

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
