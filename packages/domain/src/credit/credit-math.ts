// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Fixed-point credit arithmetic and cross-lot charge planning (task #11).
 *
 * Credits are stored as `numeric(20, 6)` because a charge is a fraction of a
 * cent and is summed across several purchases. Doing that arithmetic in binary
 * floating point leaves a residue on a lot that can neither be spent nor
 * refunded, so every calculation here runs on integer micro-credits — one
 * millionth of a credit, exactly the column's scale — and converts back only
 * at the database boundary. The largest pack is 45,660 credits, so even an
 * account's whole history stays far inside the safe integer range.
 *
 * A charge is planned rather than applied here: this module holds no database
 * access, which is what lets the ordering and the "spend what is there" rule
 * be tested without one.
 */

/** How many micro-credits make one credit — `numeric(20, 6)`'s scale. */
const MICRO_PER_CREDIT = 1_000_000;

/** The column's scale, i.e. how many digits follow the decimal point. */
const SCALE = 6;

/**
 * Convert credits to integer micro-credits.
 *
 * Strings arrive from Postgres and are matched against a plain-decimal pattern
 * before anything is read out of them: the column is wide enough to hold text
 * this code cannot represent, and a silent `NaN` would spread through a charge
 * as an amount nobody can account for. Numbers come from callers that computed
 * a cost in floating point and are rounded to the column's scale, which is the
 * last point at which a residue can still be discarded safely.
 *
 * The result is a JS number, so amounts stay exact up to about nine billion
 * credits — five orders of magnitude above the largest pack. Past that the
 * conversion loses digits, which is why the pattern above is a guard on the
 * shape of the input rather than a claim about its size.
 * @param value - A credit amount, as a numeric string or a number.
 * @returns The same amount in micro-credits.
 * @throws {Error} If a string is not a plain decimal number.
 */
export function toMicroCredits(value: number | string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`toMicroCredits: not a finite number (got ${value})`);
    }
    return Math.round(value * MICRO_PER_CREDIT);
  }

  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(value.trim());
  if (!match || (match[2] === "" && (match[3] ?? "") === "")) {
    throw new Error(
      `toMicroCredits: not a decimal number (got ${JSON.stringify(value)})`,
    );
  }
  const [, sign, whole, fraction = ""] = match;
  const padded = fraction.padEnd(SCALE, "0").slice(0, SCALE);
  const magnitude = Number(`${whole === "" ? "0" : whole}${padded}`);
  return sign === "-" ? -magnitude : magnitude;
}

/**
 * Convert micro-credits back to the string form the column takes.
 * @param micro - An amount in micro-credits.
 * @returns The amount as a decimal string with exactly six fractional digits.
 */
export function fromMicroCredits(micro: number): string {
  const sign = micro < 0 ? "-" : "";
  const magnitude = Math.abs(micro);
  const whole = Math.trunc(magnitude / MICRO_PER_CREDIT);
  const fraction = magnitude % MICRO_PER_CREDIT;
  return `${sign}${whole}.${String(fraction).padStart(SCALE, "0")}`;
}

/** A lot as the planner needs to see it: which one, and how much is left. */
export interface ChargeableLot {
  /** The lot's id. */
  id: string;
  /** What is left on it, in micro-credits. */
  remaining: number;
}

/** How much of a charge one lot carries. */
export interface LotAllocation {
  /** The lot being drawn down. */
  lotId: string;
  /** How much comes out of it, in micro-credits. Always above zero. */
  amount: number;
}

/** The result of planning one charge across several lots. */
export interface ChargePlan {
  /** One entry per lot that contributes, in the order they were given. */
  allocations: readonly LotAllocation[];
  /** What could not be covered, in micro-credits. Zero when fully covered. */
  shortfall: number;
}

/**
 * Spread one charge across lots, oldest first.
 *
 * The caller passes the lots in the order they must be spent — by
 * `created_at`, with `id` breaking ties — and this walks them taking
 * `min(what is left on it, what is still owed)` from each. A lot that
 * contributes nothing produces no allocation, so it produces no ledger row
 * either: a zero-amount row records that nothing happened and is noise in the
 * per-lot reconciliation.
 *
 * What cannot be covered comes back as `shortfall` rather than as a failure.
 * The charge runs after delivery — the user is entitled to the result they
 * already have — so the caller charges what is there and logs the rest for
 * reconciliation. Refusing here would mean either failing a task that already
 * succeeded or recording nothing at all for it.
 * @param lots - Chargeable lots, already in spend order.
 * @param amount - What to charge, in micro-credits.
 * @returns Which lots carry how much, plus whatever is left uncovered.
 */
export function planCharge(
  lots: readonly ChargeableLot[],
  amount: number,
): ChargePlan {
  const allocations: LotAllocation[] = [];
  let owed = amount;

  for (const lot of lots) {
    if (owed <= 0) break;
    if (lot.remaining <= 0) continue;
    const taken = Math.min(lot.remaining, owed);
    allocations.push({ lotId: lot.id, amount: taken });
    owed -= taken;
  }

  return { allocations, shortfall: owed };
}
