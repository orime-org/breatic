// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A task's deadline counted from when it started (inner#1367 §4.8c): the one
 * place the two-hour budget is added to a start.
 */

import { describe, it, expect } from "vitest";

import { budgetDeadlineFrom, getNodeTaskConfig } from "@core/config/node-tasks.js";

describe("budgetDeadlineFrom", () => {
  it("adds the configured budget to the start", () => {
    expect(budgetDeadlineFrom(1_000)).toBe(1_000 + getNodeTaskConfig().default_budget_ms);
  });
});
