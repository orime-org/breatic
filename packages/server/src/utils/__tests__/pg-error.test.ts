// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from "vitest";

import { isUniqueViolation } from "@server/utils/pg-error.js";

describe("isUniqueViolation", () => {
  it("detects a top-level SQLSTATE 23505", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
  });

  it("detects a 23505 wrapped on .cause (drizzle DrizzleQueryError shape)", () => {
    // The bug the older top-level-only copies missed: inside db.transaction,
    // drizzle 0.45 wraps the driver error and hangs the real pg error on .cause.
    const wrapped = { name: "DrizzleQueryError", cause: { code: "23505" } };
    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  it("detects a 23505 nested deeper in the cause chain", () => {
    const nested = { cause: { cause: { code: "23505" } } };
    expect(isUniqueViolation(nested)).toBe(true);
  });

  it("returns false for a non-unique-violation code", () => {
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(isUniqueViolation({ cause: { code: "23503" } })).toBe(false);
  });

  it("returns false for non-error shapes", () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
  });

  it("is bounded — does not loop forever on a cause cycle", () => {
    const a: { cause?: unknown } = {};
    const b: { cause?: unknown } = { cause: a };
    a.cause = b;
    expect(isUniqueViolation(a)).toBe(false);
  });
});
