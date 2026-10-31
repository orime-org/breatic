// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { bisectMediaCore, expandMediaDecodeWindow } from "@breatic/shared";

describe("bisectMediaCore", () => {
  it("splits an original-time core into adjacent, non-overlapping halves", () => {
    expect(bisectMediaCore({ startUs: "1000000", endUs: "9000000" })).toEqual([
      { startUs: "1000000", endUs: "5000000" },
      { startUs: "5000000", endUs: "9000000" },
    ]);
  });

  it("preserves the full parent coverage for every representable interval", () => {
    fc.assert(fc.property(
      fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }),
      fc.bigInt({ min: 2n, max: 10n ** 12n }),
      (startUs, widthUs) => {
        const endUs = startUs + widthUs;
        const [left, right] = bisectMediaCore({ startUs: String(startUs), endUs: String(endUs) });

        expect(BigInt(left.startUs)).toBe(startUs);
        expect(BigInt(left.endUs)).toBe(BigInt(right.startUs));
        expect(BigInt(right.endUs)).toBe(endUs);
      },
    ), { numRuns: 200 });
  });

  it("refuses a core that cannot be split at integer-microsecond precision", () => {
    expect(() => bisectMediaCore({ startUs: "0", endUs: "1" })).toThrow(RangeError);
    expect(() => bisectMediaCore({ startUs: "2", endUs: "2" })).toThrow(RangeError);
    expect(() => bisectMediaCore({ startUs: "3", endUs: "2" })).toThrow(RangeError);
    expect(() => bisectMediaCore({ startUs: "01", endUs: "3" })).toThrow(RangeError);
  });
});

describe("expandMediaDecodeWindow", () => {
  it("adds overlap around a core while clamping to the source bounds", () => {
    expect(expandMediaDecodeWindow(
      { startUs: "10000000", endUs: "20000000" },
      { startUs: "0", endUs: "25000000" },
      "3000000",
    )).toEqual({
      core: { startUs: "10000000", endUs: "20000000" },
      decode: { startUs: "7000000", endUs: "23000000" },
    });
    expect(expandMediaDecodeWindow(
      { startUs: "0", endUs: "10000000" },
      { startUs: "0", endUs: "25000000" },
      "3000000",
    ).decode).toEqual({ startUs: "0", endUs: "13000000" });
  });

  it("rejects a core outside its source range and a negative overlap", () => {
    expect(() => expandMediaDecodeWindow(
      { startUs: "0", endUs: "10000000" },
      { startUs: "1000000", endUs: "11000000" },
      "0",
    )).toThrow(RangeError);
    expect(() => expandMediaDecodeWindow(
      { startUs: "0", endUs: "10000000" },
      { startUs: "0", endUs: "10000000" },
      "-1",
    )).toThrow(RangeError);
  });
});
