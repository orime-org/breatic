// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from "vitest";

import { failureOutcome } from "@domain/node-task/failure-outcome.js";

/** A task that ends in failure at its deadline ended at its deadline (inner#1367). */
describe("failureOutcome", () => {
  const DEADLINE = 1_800_000_000_000;

  it("is expired once the deadline has come", () => {
    expect(failureOutcome(DEADLINE, DEADLINE)).toBe("expired");
    expect(failureOutcome(DEADLINE, DEADLINE + 1)).toBe("expired");
  });

  it("is failed before it", () => {
    expect(failureOutcome(DEADLINE, DEADLINE - 1)).toBe("failed");
  });
});
