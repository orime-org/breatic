// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, it, expect } from "vitest";

import { creditsForUsd } from "@domain/credit/usage-cost.js";

describe("credits for a dollar amount", () => {
  it("is one credit per cent, times the multiplier", () => {
    expect(creditsForUsd(0.0123, 1)).toBeCloseTo(1.23, 10);
    expect(creditsForUsd(0.0123, 2.5)).toBeCloseTo(3.075, 10);
  });
});
