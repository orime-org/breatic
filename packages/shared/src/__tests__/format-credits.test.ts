// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One rule for writing a credit amount, read by the panels, the proposal card
 * and the agent: part-credits are charged, so they show, to two decimals.
 */
import { describe, expect, it } from "vitest";
import { formatCredits } from "@shared/format-credits";

describe("formatCredits", () => {
  it("keeps part-credits to two decimals", () => {
    expect(formatCredits(3.456, "en-US")).toBe("3.46");
    expect(formatCredits(47.5, "en-US")).toBe("47.5");
  });

  it("groups digits the way the locale does", () => {
    expect(formatCredits(1234.5, "en-US")).toBe("1,234.5");
    expect(formatCredits(1234.5, "de-DE")).toBe("1.234,5");
  });
});
