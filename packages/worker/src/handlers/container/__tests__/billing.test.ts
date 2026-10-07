// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from "vitest";

import { containerCostUsd } from "@worker/handlers/container/billing.js";

const STD1 = { vcpu: 0.5, memory_gib: 4, disk_gb: 8 };
const PRICES = { vcpu_second_usd: 0.00002, memory_gib_second_usd: 0.0000025, disk_gb_second_usd: 0.00000007 };

describe("containerCostUsd", () => {
  it("bills memory and disk over the wall time and cpu over the measured cpu time", () => {
    const cost = containerCostUsd({ wallMs: 60_000, cpuUsec: 20_000_000 }, STD1, PRICES);
    const expected = 60 * (4 * 0.0000025 + 8 * 0.00000007) + 20 * 0.00002;
    expect(cost).toBeCloseTo(expected, 12);
  });

  it("bills the class's full vcpu over the wall time when cpu time could not be read", () => {
    const cost = containerCostUsd({ wallMs: 60_000, cpuUsec: null }, STD1, PRICES);
    const expected = 60 * (4 * 0.0000025 + 8 * 0.00000007) + 60 * 0.5 * 0.00002;
    expect(cost).toBeCloseTo(expected, 12);
  });

  it("answers the same number every time it is asked about the same report", () => {
    const usage = { wallMs: 12_345, cpuUsec: 3_000_000 };
    expect(containerCostUsd(usage, STD1, PRICES)).toBe(containerCostUsd(usage, STD1, PRICES));
  });
});
