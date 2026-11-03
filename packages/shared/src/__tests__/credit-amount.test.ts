// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import * as shared from "@shared/index.js";

interface ExactCreditApi {
  parseCreditDecimal: (value: string) => bigint;
  serializeCreditMicro: (value: bigint) => string;
  parseGrantCredits: (value: string) => string;
  quantizeQuotedCredits: (value: number) => bigint;
}

const api = shared as unknown as ExactCreditApi;

/**
 * Obtain an exact-money entry from the public package contract.
 * @param name - Required function name.
 * @returns The callable public entry.
 * @throws {Error} When the entry has not been exported.
 */
function entry<K extends keyof ExactCreditApi>(name: K): ExactCreditApi[K] {
  expect(typeof api[name], `Public credit API ${name}`).toBe("function");
  return api[name];
}

/**
 * Capture a rejected decimal input's contract error class.
 * @param call - Invocation of the public parser.
 * @returns The consistent contract error name.
 * @throws {Error} When the parser accepts the input or throws a foreign error.
 */
function decimalError(call: () => unknown): string {
  let thrown: unknown;
  try {
    call();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  const name = (thrown as Error).name;
  expect(["RangeError", "ZodError"]).toContain(name);
  return name;
}

describe("exact credit decimal contract (inner#1411)", () => {
  it.each([
    ["0001.2", 1_200_000n, "1.200000"],
    ["-0.000000", 0n, "0.000000"],
    ["0.000001", 1n, "0.000001"],
    ["-0.000001", -1n, "-0.000001"],
    ["99999999999999.999999", 99_999_999_999_999_999_999n, "99999999999999.999999"],
    ["-99999999999999.999999", -99_999_999_999_999_999_999n, "-99999999999999.999999"],
  ] as const)("parses %s and serializes its exact micro-credits", (text, micro, canonical) => {
    const parse = entry("parseCreditDecimal");
    const serialize = entry("serializeCreditMicro");
    expect(parse(text)).toBe(micro);
    expect(serialize(parse(text))).toBe(canonical);
  });

  it.each(["", " ", " 1 ", ".", "1e2", "NaN", "Infinity", "1.0000001"])("rejects invalid stored decimal %j", (text) => {
    const parse = entry("parseCreditDecimal");
    decimalError(() => parse(text));
  });

  it("uses one contract error class for invalid stored decimals", () => {
    const parse = entry("parseCreditDecimal");
    const names = ["", " ", " 1 ", ".", "1e2", "NaN", "Infinity", "1.0000001"]
      .map((text) => decimalError(() => parse(text)));
    expect(new Set(names).size).toBe(1);
  });

  it("retains aggregates above one numeric row's capacity and a single-micro debit", () => {
    const parse = entry("parseCreditDecimal");
    const serialize = entry("serializeCreditMicro");
    const total = parse("99999999999999.999999") + parse("99999999999999.999999");
    expect(serialize(total)).toBe("199999999999999.999998");
    expect(serialize(total - 1n)).toBe("199999999999999.999997");
  });

  it("serializes an exact amount into JSON as a decimal string", () => {
    const parse = entry("parseCreditDecimal");
    const serialize = entry("serializeCreditMicro");
    expect(JSON.stringify({ credits: serialize(parse("99999999999999.999999")) }))
      .toBe('{"credits":"99999999999999.999999"}');
  });

  it("round-trips signed micro-credits across the row and aggregate domains", () => {
    const parse = entry("parseCreditDecimal");
    const serialize = entry("serializeCreditMicro");
    fc.assert(
      fc.property(
        fc.bigInt({ min: -199_999_999_999_999_999_998n, max: 199_999_999_999_999_999_998n }),
        (micro) => {
          expect(parse(serialize(micro))).toBe(micro);
        },
      ),
      { seed: 141101, numRuns: 2000 },
    );
  });

  it("preserves signed addition and subtraction through the decimal boundary", () => {
    const parse = entry("parseCreditDecimal");
    const serialize = entry("serializeCreditMicro");
    const amount = fc.bigInt({ min: -99_999_999_999_999_999_999n, max: 99_999_999_999_999_999_999n });
    fc.assert(
      fc.property(amount, amount, (left, right) => {
        expect(parse(serialize(left + right)) - parse(serialize(right))).toBe(left);
        expect(parse(serialize(left - right)) + parse(serialize(right))).toBe(left);
      }),
      { seed: 141102, numRuns: 2000 },
    );
  });
});

describe("operator grant quantity contract", () => {
  it.each([
    ["1", "1.00"],
    ["0.1", "0.10"],
    [" 100.00 ", "100.00"],
    ["0.01", "0.01"],
    ["99999999999999.99", "99999999999999.99"],
  ] as const)("normalizes %j to %s", (text, expected) => {
    expect(entry("parseGrantCredits")(text)).toBe(expected);
  });

  it.each(["0", "0.00", "-1", "100000000000000.00", "0.001", "1e2", "NaN", "Infinity", "", " "])("rejects invalid grant quantity %j", (text) => {
    const parse = entry("parseGrantCredits");
    decimalError(() => parse(text));
  });

  it("uses one contract error class for invalid grant quantities", () => {
    const parse = entry("parseGrantCredits");
    const names = ["0", "-1", "100000000000000.00", "0.001", "1e2", "NaN", "Infinity", ""]
      .map((text) => decimalError(() => parse(text)));
    expect(new Set(names).size).toBe(1);
  });
});

describe("quoted-cost quantization", () => {
  it.each([
    [7.000000000000001, 7_000_000n],
    [1e-7, 0n],
    [5e-7, 1n],
    [0.010001, 10_001n],
    [0, 0n],
  ] as const)("quantizes %s before settling whole credit cents", (quote, expected) => {
    expect(entry("quantizeQuotedCredits")(quote)).toBe(expected);
  });
});
