// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A task's reading is bounded by the task's deadline and by nothing of its
 * own (inner#1367): every figure is what is left of it.
 */

import { describe, it, expect } from "vitest";

import { readingLimitsUntil } from "@domain/understand/limits-until.js";

const NOW = 1_800_000_000_000;
const MAX_BYTES = 20 * 1024 * 1024;

describe("readingLimitsUntil", () => {
  it("gives the fetch, the read and the call what is left", () => {
    const limits = readingLimitsUntil(NOW + 90_000, MAX_BYTES, NOW);

    expect(limits.fetchTimeoutMs).toBe(90_000);
    expect(limits.readFloorMs).toBe(90_000);
    expect(limits.timeoutMs).toBe(90_000);
  });

  // The read budget is max(floor, size / rate). The rate is the one at which
  // the largest file this reading takes arrives in exactly what is left, so the
  // budget is never larger than the deadline allows.
  it("never lets the size of a file stretch the read past what is left", () => {
    const limits = readingLimitsUntil(NOW + 90_000, MAX_BYTES, NOW);

    expect((MAX_BYTES / limits.minBytesPerSec) * 1000).toBeLessThanOrEqual(90_000);
  });

  it("carries the deadline as the signal", () => {
    const limits = readingLimitsUntil(NOW + 90_000, MAX_BYTES, NOW);

    expect(limits.signal).toBeInstanceOf(AbortSignal);
  });
});
