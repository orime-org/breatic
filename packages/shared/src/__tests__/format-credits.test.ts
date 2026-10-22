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

  it("rounds a third decimal up, never down (inner#1666)", () => {
    expect(formatCredits(3.451, "en-US")).toBe("3.46");
    expect(formatCredits(3.001, "en-US")).toBe("3.01");
    expect(formatCredits(7, "en-US")).toBe("7");
  });

  it("does not show floating-point residue as an extra cent", () => {
    expect(formatCredits(0.1 + 0.2, "en-US")).toBe("0.3");
    expect(formatCredits(7.000000000000001, "en-US")).toBe("7");
  });

  it("rounds a negative amount away from zero, like the charge it records", () => {
    expect(formatCredits(-3.4512, "en-US")).toBe("-3.46");
    expect(formatCredits(-0.004, "en-US")).toBe("-0.01");
  });

  it("groups digits the way the locale does", () => {
    expect(formatCredits(1234.5, "en-US")).toBe("1,234.5");
    expect(formatCredits(1234.5, "de-DE")).toBe("1.234,5");
  });
});
