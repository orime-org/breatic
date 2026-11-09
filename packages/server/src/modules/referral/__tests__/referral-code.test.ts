// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  generateReferralCode,
  isValidReferralCode,
  parseReferralCode,
  REFERRAL_CODE_ALPHABET,
} from "../referral-code.js";

describe("parseReferralCode", () => {
  it("trims surrounding whitespace and upper-cases what was typed", () => {
    expect(parseReferralCode("  alice \n")).toBe("ALICE");
    expect(parseReferralCode("k7q2-m9xd")).toBe("K7Q2-M9XD");
  });

  it.each([
    ["ABCD", "ABCD"],
    ["A1-B2", "A1-B2"],
    ["A".repeat(20), "A".repeat(20)],
  ])("accepts %s", (input, expected) => {
    expect(parseReferralCode(input)).toBe(expected);
  });

  it.each([
    ["", "empty"],
    ["ABC", "three characters"],
    ["A".repeat(21), "twenty-one characters"],
    ["-ABC", "a leading hyphen"],
    ["ABC-", "a trailing hyphen"],
    ["AB_C", "an underscore"],
    ["AB CD", "an inner space"],
    ["ÄBCD", "a non-ASCII letter"],
  ])("rejects %s (%s)", (input) => {
    expect(parseReferralCode(input)).toBeNull();
  });

  it("returns either null or a valid code, and parsing that code again changes nothing", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (input) => {
        const parsed = parseReferralCode(input);
        if (parsed === null) return true;
        return isValidReferralCode(parsed) && parseReferralCode(parsed) === parsed;
      }),
    );
  });

  it("treats codes that differ only in case and surrounding whitespace as the same code", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9-]{2,18}[A-Za-z0-9]$/),
        fc.constantFrom("", " ", "\t", "\n"),
        (code, pad) => parseReferralCode(`${pad}${code.toLowerCase()}${pad}`) === parseReferralCode(code.toUpperCase()),
      ),
    );
  });
});

describe("generateReferralCode", () => {
  it("draws eight characters from the unambiguous alphabet", () => {
    expect(REFERRAL_CODE_ALPHABET).toBe("23456789ABCDEFGHJKLMNPQRSTUVWXYZ");
    for (let i = 0; i < 2000; i += 1) {
      const code = generateReferralCode();
      expect(code).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
      expect(parseReferralCode(code)).toBe(code);
    }
  });
});
