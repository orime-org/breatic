// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  toMicroCredits,
  fromMicroCredits,
  planCharge,
  positionFrom,
  toChargeMicro,
  toChargeCredits,
  SMALLEST_CREDIT,
} from "@domain/credit/credit-math.js";

/**
 * Attach the production micro-credit unit to an independently known fixture.
 * @param value - The fixture's integer micro-credits.
 * @returns The amount in the planner's unit.
 */
function micro(value: bigint): ReturnType<typeof toMicroCredits> {
  return value as unknown as ReturnType<typeof toMicroCredits>;
}

/**
 * Build one planner input with an explicit micro-credit balance.
 * @param id - The lot identity in FIFO order.
 * @param remaining - Its independent integer fixture.
 * @returns The lot supplied to the planner.
 */
function lot(id: string, remaining: bigint): Parameters<typeof planCharge>[0][number] {
  return { id, remaining: micro(remaining) };
}

describe("positionFrom (inner#1611)", () => {
  it("takes running holds off the spendable balance in micro-credits", () => {
    expect(positionFrom("100", "0", "80")).toEqual({ spendable: 100_000_000n, held: 80_000_000n, available: 20_000_000n });
  });

  it("reads zero available when holds outgrow a nonnegative balance", () => {
    expect(positionFrom("40", "0", "45")).toEqual({ spendable: 40_000_000n, held: 45_000_000n, available: 0n });
  });

  it("retains negative spendable credit while the studio owes", () => {
    expect(positionFrom("0", "30", "10")).toEqual({ spendable: -30_000_000n, held: 10_000_000n, available: -30_000_000n });
  });

  it("retains an available cent beside a large active hold (inner#1411)", () => {
    expect(positionFrom("99999999999999.990000", "0", "99999999999999.980000"))
      .toEqual({ spendable: 99_999_999_999_999_990_000n, held: 99_999_999_999_999_980_000n, available: 10_000n });
  });

  it("allows a sum of valid lots above the single-row bound", () => {
    expect(positionFrom("199999999999999.999998", "0.000001", "0.000000"))
      .toEqual({ spendable: 199_999_999_999_999_999_997n, held: 0n, available: 199_999_999_999_999_999_997n });
  });

  it("bounds availability by the exact balance and counted holds", () => {
    const amount = fc.bigInt({ min: 0n, max: 199_999_999_999_999_999_998n });
    fc.assert(
      fc.property(amount, amount, amount, (lots, debt, held) => {
        const position = positionFrom(fromMicroCredits(micro(lots)), fromMicroCredits(micro(debt)), fromMicroCredits(micro(held)));
        expect(position.spendable).toBe(lots - debt);
        expect(position.held).toBe(held);
        if (lots < debt) expect(position.available).toBe(lots - debt);
        else {
          expect(position.available >= 0n && position.available <= lots - debt).toBe(true);
          expect(position.available).toBe(lots - debt >= held ? lots - debt - held : 0n);
        }
      }),
      { seed: 141112, numRuns: 2000 },
    );
  });
});

describe("micro-credit conversion", () => {
  it("converts stored decimal strings to exact integer micro-credits", () => {
    expect(toMicroCredits("880.000000")).toBe(880_000_000n);
    expect(toMicroCredits("0.000001")).toBe(1n);
    expect(toMicroCredits("-0.000001")).toBe(-1n);
    expect(toMicroCredits("0")).toBe(0n);
    expect(toMicroCredits("12.345678")).toBe(12_345_678n);
  });

  it("accepts the existing shorter decimal forms", () => {
    expect(toMicroCredits("1.5")).toBe(1_500_000n);
    expect(toMicroCredits("1.")).toBe(1_000_000n);
  });

  it("quantizes a quoted number to micro-credits", () => {
    expect(toMicroCredits(0.1 + 0.2)).toBe(300_000n);
    expect(toMicroCredits(12.345678)).toBe(12_345_678n);
  });

  it("rejects invalid decimal strings and non-finite quotes", () => {
    expect(() => toMicroCredits("abc")).toThrow(/decimal number/);
    expect(() => toMicroCredits("")).toThrow(/decimal number/);
    expect(() => toMicroCredits("1e5")).toThrow(/decimal number/);
    expect(() => toMicroCredits("1,5")).toThrow(/decimal number/);
    expect(() => toMicroCredits(Number.NaN)).toThrow(/finite number/);
    expect(() => toMicroCredits(Number.POSITIVE_INFINITY)).toThrow(/finite number/);
  });

  it("preserves adjacent micros above the number-based conversion boundary", () => {
    const first = toMicroCredits("9007199254.740000");
    const second = toMicroCredits("9007199254.740001");
    expect(first).toBe(9_007_199_254_740_000n);
    expect(second).toBe(9_007_199_254_740_001n);
    expect(second - first).toBe(1n);
    expect(fromMicroCredits(second)).toBe("9007199254.740001");
  });

  it("writes six decimal digits at the SQL boundary", () => {
    expect(fromMicroCredits(micro(880_000_000n))).toBe("880.000000");
    expect(fromMicroCredits(micro(1n))).toBe("0.000001");
    expect(fromMicroCredits(micro(-1n))).toBe("-0.000001");
    expect(fromMicroCredits(micro(0n))).toBe("0.000000");
  });

  it("round-trips signed stored and aggregate values", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -199_999_999_999_999_999_998n, max: 199_999_999_999_999_999_998n }), (value) => {
        expect(toMicroCredits(fromMicroCredits(micro(value)))).toBe(value);
      }),
      { seed: 141111, numRuns: 2000 },
    );
  });
});

describe("planCharge", () => {
  it("draws only on the first lot when it covers the charge", () => {
    const plan = planCharge([lot("a", 100n), lot("b", 100n)], micro(30n));
    expect(plan.allocations).toEqual([{ lotId: "a", amount: 30n }]);
    expect(plan.shortfall).toBe(0n);
  });

  it("allocates to several lots in their supplied FIFO order", () => {
    const plan = planCharge([lot("a", 30n), lot("b", 100n)], micro(50n));
    expect(plan.allocations).toEqual([{ lotId: "a", amount: 30n }, { lotId: "b", amount: 20n }]);
    expect(plan.shortfall).toBe(0n);
  });

  it("does not allocate zero to the next lot when one is exhausted exactly", () => {
    const plan = planCharge([lot("a", 30n), lot("b", 100n)], micro(30n));
    expect(plan.allocations).toEqual([{ lotId: "a", amount: 30n }]);
    expect(plan.shortfall).toBe(0n);
  });

  it("returns the uncovered amount after drawing down the available lots", () => {
    const plan = planCharge([lot("a", 30n), lot("b", 10n)], micro(100n));
    expect(plan.allocations).toEqual([{ lotId: "a", amount: 30n }, { lotId: "b", amount: 10n }]);
    expect(plan.shortfall).toBe(60n);
  });

  it("returns the whole charge as shortfall when no lot is available", () => {
    const plan = planCharge([], micro(100n));
    expect(plan.allocations).toEqual([]);
    expect(plan.shortfall).toBe(100n);
  });

  it("skips lots with no remaining credits", () => {
    const plan = planCharge([lot("a", 0n), lot("b", 50n)], micro(20n));
    expect(plan.allocations).toEqual([{ lotId: "b", amount: 20n }]);
    expect(plan.shortfall).toBe(0n);
  });

  it("does nothing for a zero charge", () => {
    const plan = planCharge([lot("a", 50n)], micro(0n));
    expect(plan.allocations).toEqual([]);
    expect(plan.shortfall).toBe(0n);
  });

  it("takes a large lot followed by one exact credit cent", () => {
    const plan = planCharge([lot("a", 9_007_199_254_740_000n), lot("b", 10_000n)], micro(9_007_199_254_750_000n));
    expect(plan.allocations).toEqual([{ lotId: "a", amount: 9_007_199_254_740_000n }, { lotId: "b", amount: 10_000n }]);
    expect(plan.shortfall).toBe(0n);
  });

  it("retains a single-micro shortfall after a large FIFO allocation", () => {
    const plan = planCharge([lot("a", 9_007_199_254_740_000n), lot("b", 10_000n)], micro(9_007_199_254_750_001n));
    expect(plan.allocations).toEqual([{ lotId: "a", amount: 9_007_199_254_740_000n }, { lotId: "b", amount: 10_000n }]);
    expect(plan.shortfall).toBe(1n);
  });

  it("preserves sub-cent debt after allocating the largest two-decimal grant", () => {
    const plan = planCharge([lot("grant", 99_999_999_999_999_990_000n)], micro(99_999_999_999_999_999_999n));
    expect(plan.allocations).toEqual([{ lotId: "grant", amount: 99_999_999_999_999_990_000n }]);
    expect(plan.shortfall).toBe(9_999n);
  });

  it("conserves every charge and bounds each nonzero allocation by its lot", () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 0n, max: 99_999_999_999_999_999_999n }), { maxLength: 20 }),
        fc.bigInt({ min: 0n, max: 199_999_999_999_999_999_998n }),
        (remainings, amount) => {
          const lots = remainings.map((remaining, index) => lot(`lot-${index}`, remaining));
          const plan = planCharge(lots, micro(amount));
          const allocated = plan.allocations.reduce((sum, allocation) => sum + allocation.amount, 0n);
          const capacity = remainings.reduce((sum, remaining) => sum + remaining, 0n);
          expect(allocated + plan.shortfall).toBe(amount);
          expect(plan.shortfall).toBe(amount > capacity ? amount - capacity : 0n);
          const totals = new Map<string, bigint>();
          for (const allocation of plan.allocations) {
            expect(allocation.amount).toBeGreaterThan(0n);
            totals.set(allocation.lotId, (totals.get(allocation.lotId) ?? 0n) + allocation.amount);
          }
          expect(totals.size).toBe(plan.allocations.length);
          let previousIndex = -1;
          for (const allocation of plan.allocations) {
            const index = lots.findIndex((candidate) => candidate.id === allocation.lotId);
            expect(index).toBeGreaterThan(previousIndex);
            expect(totals.get(allocation.lotId)).toBeLessThanOrEqual(lots[index]!.remaining);
            for (const prior of lots.slice(0, index)) {
              expect(totals.get(prior.id) ?? 0n).toBe(prior.remaining);
            }
            previousIndex = index;
          }
        },
      ),
      { seed: 141114, numRuns: 2000 },
    );
  });
});

describe("toChargeMicro (inner#1666)", () => {
  it.each([
    [3.075, 3_080_000n],
    [0.001, 10_000n],
    [7.25, 7_250_000n],
    [7.000000000000001, 7_000_000n],
    [1e-7, 0n],
    [5e-7, 10_000n],
    [0.010001, 20_000n],
  ] as const)("settles the quoted amount %s to %s micro-credits", (quote, expected) => {
    expect(toChargeMicro(quote)).toBe(expected);
  });

  it("lands on a whole cent with a charge less than one cent above quantized input", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 50_000_000_000 }), (quotedMicro) => {
        const charged = toChargeMicro(quotedMicro / 1_000_000);
        expect(charged % 10_000n).toBe(0n);
        expect(charged).toBeGreaterThanOrEqual(BigInt(quotedMicro));
        expect(charged - BigInt(quotedMicro)).toBeLessThan(10_000n);
      }),
      { seed: 141107, numRuns: 2000 },
    );
  });

  it("keeps exact cents when a nonnegative quote has sub-micro residue", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5_000_000 }), fc.double({ min: -4e-7, max: 4e-7, noNaN: true }), (cents, noise) => {
        const quote = Math.max(0, cents / 100 + noise);
        expect(toChargeMicro(quote)).toBe(BigInt(cents) * 10_000n);
      }),
    );
  });

  it("makes a cent the smallest quoted credit for admission", () => {
    expect(SMALLEST_CREDIT).toBe(0.01);
  });
});

describe("toChargeCredits quote records", () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("retains the existing non-positive or non-finite quote %s", (value) => {
    expect(toChargeCredits(value)).toBe(value);
  });

  it("keeps a settled positive quote as a number for usage and task records", () => {
    expect(toChargeCredits(0.010001)).toBe(0.02);
    expect(typeof toChargeCredits(0.010001)).toBe("number");
    expect(toChargeCredits(7.000000000000001)).toBe(7);
  });
});
