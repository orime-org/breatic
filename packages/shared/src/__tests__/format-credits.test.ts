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

  it("writes a fixed number of decimals when a column asks for it, so the points line up (inner#1666)", () => {
    expect(formatCredits(6.3, "en-US", 2)).toBe("6.30");
    expect(formatCredits(-0.1, "en-US", 2)).toBe("-0.10");
    expect(formatCredits(7, "en-US", 2)).toBe("7.00");
    expect(formatCredits(3.451, "en-US", 2)).toBe("3.46");
    expect(formatCredits(1234.5, "de-DE", 2)).toBe("1.234,50");
  });

  it("groups digits the way the locale does", () => {
    expect(formatCredits(1234.5, "en-US")).toBe("1,234.5");
    expect(formatCredits(1234.5, "de-DE")).toBe("1.234,5");
  });
});


describe("exact credit display contract (inner#1411)", () => {
  it("formats the existing large-number counterexample without adding a cent", () => {
    expect(formatCredits(9_007_199_254.70, "en", 2)).toBe("9,007,199,254.70");
    expect(formatCredits(18_014_398_509.47, "en", 2)).toBe("18,014,398,509.47");
  });

  it.each(["en", "zh-CN", "zh-TW", "ja", "ko"])("formats an exact decimal in %s", (locale) => {
    expect(formatCredits("9007199254.700000", locale, 2)).toBe("9,007,199,254.70");
    expect(formatCredits("-0.000001", locale, 2)).toBe("-0.01");
    expect(formatCredits("0.000000", locale)).toBe("0");
    expect(formatCredits("0.000000", locale, 2)).toBe("0.00");
  });

  it("retains the exact pair aggregate before display rounding", () => {
    expect(formatCredits("18014398509.470000", "en", 2)).toBe("18,014,398,509.47");
  });

  it("carries a maximal stored row into the next displayed credit cent", () => {
    expect(formatCredits("99999999999999.999999", "en", 2)).toBe("100,000,000,000,000.00");
  });

  it("formats a multi-row aggregate above a stored row's upper bound", () => {
    expect(formatCredits("199999999999999.999998", "en", 2)).toBe("200,000,000,000,000.00");
  });

  it("keeps fixed and optional fractional digits on exact decimal inputs", () => {
    expect(formatCredits("47.500000", "en")).toBe("47.5");
    expect(formatCredits("47.500000", "en", 2)).toBe("47.50");
    expect(formatCredits("-0.100000", "en", 2)).toBe("-0.10");
    expect(formatCredits("-0.000000", "en", 2)).toBe("0.00");
    expect(formatCredits("1234.500000", "de-DE", 2)).toBe("1.234,50");
  });
});
