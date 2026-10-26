// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every settled credit amount has at most two decimals and is rounded up, once
 * floating-point residue below a micro-credit is discarded (inner#1666,
 * inner#1637).
 */
import { describe, expect, it } from "vitest";
import { ceilToCreditCent } from "@shared/credit-cent";

describe("ceilToCreditCent", () => {
  it("raises the second decimal when a third one is present", () => {
    expect(ceilToCreditCent(3.075)).toBe(3.08);
    expect(ceilToCreditCent(3.451)).toBe(3.46);
    expect(ceilToCreditCent(0.001)).toBe(0.01);
    expect(ceilToCreditCent(12.345678)).toBe(12.35);
  });

  it("leaves amounts of two decimals or fewer as they are", () => {
    expect(ceilToCreditCent(0)).toBe(0);
    expect(ceilToCreditCent(7)).toBe(7);
    expect(ceilToCreditCent(7.25)).toBe(7.25);
    expect(ceilToCreditCent(0.07)).toBe(0.07);
  });

  it("does not round floating-point residue up a whole cent (inner#1637)", () => {
    expect(ceilToCreditCent(7.000000000000001)).toBe(7);
    expect(ceilToCreditCent(0.1 + 0.2)).toBe(0.3);
    expect(ceilToCreditCent(1.1 + 2.2)).toBe(3.3);
  });

  it("rejects a negative or non-finite amount", () => {
    expect(() => ceilToCreditCent(-0.01)).toThrow();
    expect(() => ceilToCreditCent(Number.NaN)).toThrow();
    expect(() => ceilToCreditCent(Number.POSITIVE_INFINITY)).toThrow();
  });
});
