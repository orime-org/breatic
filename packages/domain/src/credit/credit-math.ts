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
 * at the database boundary. BigInt also preserves aggregates wider than one stored row.
 *
 * A charge is planned rather than applied here: this module holds no database
 * access, which is what lets the ordering and the "spend what is there" rule
 * be tested without one.
 */

import { ceilToCreditCent, ceilCreditMicroToCent, quantizeQuotedCredits, parseCreditDecimal, serializeCreditMicro, type CreditDecimal } from "@breatic/shared";

/** The smallest credit amount a studio can spend. */
export const SMALLEST_CREDIT = 0.01;

/**
 * Parse stored credits or quantize a quoted number to exact millionths.
 * @param value - The amount to convert.
 * @throws {RangeError} When the amount is not a valid decimal or finite quote.
 * @returns The converted or computed exact amount.
 */
export function toMicroCredits(value: number | string): bigint {
  return typeof value === "string" ? parseCreditDecimal(value) : quantizeQuotedCredits(Math.abs(value)) * (value < 0 ? -1n : 1n);
}

/**
 * Settle a non-negative quote to whole credit cents.
 * @param credits - The vendor quote in credits.
 * @throws {RangeError} When the quote is negative or non-finite.
 * @returns The converted or computed exact amount.
 */
export function toChargeMicro(credits: number): bigint {
  return ceilCreditMicroToCent(quantizeQuotedCredits(credits));
}

/**
 * Keep post-vendor invalid values available to existing skip and log paths.
 * @param credits - The vendor quote in credits.
 * @throws {RangeError} When a positive quote cannot be quantized.
 * @returns The converted or computed exact amount.
 */
export function toChargeCredits(credits: number): number {
  return Number.isFinite(credits) && credits > 0 ? ceilToCreditCent(credits) : credits;
}

/**
 * Serialize exact millionths at the database or HTTP boundary.
 * @param micro - The exact amount in millionths.
 * @returns The converted or computed exact amount.
 */
export function fromMicroCredits(micro: bigint): CreditDecimal {
  return serializeCreditMicro(micro);
}

/** A lot as the planner needs to see it: which one, and how much is left. */
export interface ChargeableLot {
  /** The lot's id. */
  id: string;
  /** What is left on it, in micro-credits. */
  remaining: bigint;
}

/** How much of a charge one lot carries. */
export interface LotAllocation {
  /** The lot being drawn down. */
  lotId: string;
  /** How much comes out of it, in micro-credits. Always above zero. */
  amount: bigint;
}

/** The result of planning one charge across several lots. */
export interface ChargePlan {
  /** One entry per lot that contributes, in the order they were given. */
  allocations: readonly LotAllocation[];
  /** What could not be covered, in micro-credits. Zero when fully covered. */
  shortfall: bigint;
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
  amount: bigint,
): ChargePlan {
  const allocations: LotAllocation[] = [];
  let owed = amount;

  for (const lot of lots) {
    if (owed <= 0n) break;
    if (lot.remaining <= 0n) continue;
    const taken = lot.remaining < owed ? lot.remaining : owed;
    allocations.push({ lotId: lot.id, amount: taken });
    owed -= taken;
  }

  return { allocations, shortfall: owed };
}

/**
 * A studio's balance, holds and what is left, from the three sums, so the
 * admission, its refusal and every screen that shows them compute them the
 * same way (inner#1611).
 *
 * What is left is never below zero unless the studio owes. A run charged
 * above its estimate can leave the others' holds larger than the balance;
 * nothing is left then, and a figure below zero would read as debt.
 * @param lots - What its designated lots have left, as a decimal string.
 * @param debt - What it owes, as a decimal string.
 * @param held - What counted holds add up to, as a decimal string.
 * @returns The three figures, in credits.
 * @throws {Error} If a sum is not a plain decimal number.
 */
export interface CreditPositionMicro {
  spendable: bigint;
  held: bigint;
  available: bigint;
}

/**
 * Derive the exact position used by admission.
 * @param lots - The designated lot total.
 * @param debt - The current studio debt.
 * @param held - The counted hold total.
 * @throws {RangeError} When a stored sum is not a valid decimal.
 */
export function positionFrom(lots: string, debt: string, held: string): CreditPositionMicro {
  const spendable = toMicroCredits(lots) - toMicroCredits(debt);
  const heldMicro = toMicroCredits(held);
  const afterHolds = spendable - heldMicro;
  const available = spendable < 0n ? spendable : afterHolds > 0n ? afterHolds : 0n;
  return { spendable, held: heldMicro, available };
}

/**
 * Serialize a position once it leaves internal exact arithmetic.
 * @param position - The exact internal position.
 * @returns The converted or computed exact amount.
 */
export function serializeCreditPosition(position: CreditPositionMicro): { spendable: CreditDecimal; held: CreditDecimal; available: CreditDecimal } {
  return { spendable: fromMicroCredits(position.spendable), held: fromMicroCredits(position.held), available: fromMicroCredits(position.available) };
}
