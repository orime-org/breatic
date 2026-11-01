// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";

/** An exact credit amount in millionths of a credit. */
export type CreditMicro = bigint & { readonly __creditMicro: unique symbol };
/** A canonical six-place credit amount at a database or HTTP boundary. */
export type CreditDecimal = string & { readonly __creditDecimal: unique symbol };

export const CREDIT_MICRO_PER_CREDIT = 1_000_000n;
export const CREDIT_MICRO_PER_CENT = 10_000n;
export const CREDIT_ROW_MAX_MICRO = 99_999_999_999_999_999_999n;
export const CREDIT_GRANT_MAX_MICRO = 99_999_999_999_999_990_000n;
export const CREDIT_AMOUNT_FORMAT = "decimal-v1";

/**
 * Parse a stored decimal without rounding or narrowing its magnitude.
 * @param value - The amount to convert.
 * @throws {RangeError} When the input is not a plain decimal of at most six places.
 * @returns The converted or computed exact amount.
 */
export function parseCreditDecimal(value: string): CreditMicro {
  if (typeof value !== "string") throw new RangeError("Invalid credit decimal number");
  const match = /^(-?)(\d+)(?:\.(\d{0,6}))?$/.exec(value);
  if (!match) throw new RangeError("Invalid credit decimal number");
  const magnitude = BigInt(match[2]!) * CREDIT_MICRO_PER_CREDIT + BigInt((match[3] ?? "").padEnd(6, "0"));
  return (match[1] === "-" ? -magnitude : magnitude) as CreditMicro;
}

/**
 * Serialize exact millionths to the canonical boundary representation.
 * @param value - The amount to convert.
 * @returns The converted or computed exact amount.
 */
export function serializeCreditMicro(value: bigint): CreditDecimal {
  const magnitude = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${magnitude / CREDIT_MICRO_PER_CREDIT}.${String(magnitude % CREDIT_MICRO_PER_CREDIT).padStart(6, "0")}` as CreditDecimal;
}

/**
 * Normalize an operator's positive two-place original intent.
 * @param value - The amount to convert.
 * @throws {RangeError} When the quantity is outside the grant contract.
 * @returns The converted or computed exact amount.
 */
export function parseGrantCredits(value: string): string {
  const text = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new RangeError("Invalid grant credits");
  const micro = parseCreditDecimal(text);
  if (micro < CREDIT_MICRO_PER_CENT || micro > CREDIT_GRANT_MAX_MICRO) throw new RangeError("Invalid grant credits");
  return serializeCreditMicro(micro).slice(0, -4);
}

/**
 * Quantize a vendor quote's decimal coefficient and exponent half up to millionths.
 * @param value - The amount to convert.
 * @throws {RangeError} When the quote is negative or non-finite.
 * @returns The converted or computed exact amount.
 */
export function quantizeQuotedCredits(value: number): CreditMicro {
  if (!Number.isFinite(value) || value < 0) throw new RangeError("Invalid quoted credits: not a finite number or negative");
  const [coefficient, exponent = "0"] = String(value).split("e");
  const [whole, fraction = ""] = coefficient!.split(".");
  const digits = BigInt(`${whole}${fraction}`);
  const power = Number(exponent) - fraction.length + 6;
  if (power >= 0) return (digits * 10n ** BigInt(power)) as CreditMicro;
  const divisor = 10n ** BigInt(-power);
  return ((digits + divisor / 2n) / divisor) as CreditMicro;
}

/**
 * Settle a non-negative exact amount to whole credit cents.
 * @param value - The amount to convert.
 * @throws {RangeError} When the amount is negative.
 * @returns The converted or computed exact amount.
 */
export function ceilCreditMicroToCent(value: bigint): CreditMicro {
  if (value < 0n) throw new RangeError("Invalid credit amount");
  return ((value + CREDIT_MICRO_PER_CENT - 1n) / CREDIT_MICRO_PER_CENT * CREDIT_MICRO_PER_CENT) as CreditMicro;
}

/**
 * Add exact amounts.
 * @param left - The first exact operand.
 * @param right - The second exact operand.
 * @returns The converted or computed exact amount.
 */
export function addCreditMicro(left: CreditMicro, right: CreditMicro): CreditMicro { return (left + right) as CreditMicro; }
/**
 * Subtract exact amounts.
 * @param left - The first exact operand.
 * @param right - The second exact operand.
 * @returns The converted or computed exact amount.
 */
export function subtractCreditMicro(left: CreditMicro, right: CreditMicro): CreditMicro { return (left - right) as CreditMicro; }
/**
 * Compare exact amounts.
 * @param left - The first exact operand.
 * @param right - The second exact operand.
 * @returns The converted or computed exact amount.
 */
export function compareCreditMicro(left: CreditMicro, right: CreditMicro): number { return left < right ? -1 : left > right ? 1 : 0; }
/**
 * Select the smaller amount.
 * @param left - The first exact operand.
 * @param right - The second exact operand.
 * @returns The converted or computed exact amount.
 */
export function minCreditMicro(left: CreditMicro, right: CreditMicro): CreditMicro { return (left < right ? left : right); }
/**
 * Select the larger amount.
 * @param left - The first exact operand.
 * @param right - The second exact operand.
 * @returns The converted or computed exact amount.
 */
export function maxCreditMicro(left: CreditMicro, right: CreditMicro): CreditMicro { return (left > right ? left : right); }
/**
 * Reverse an exact amount's sign.
 * @param value - The amount to convert.
 * @returns The converted or computed exact amount.
 */
export function negateCreditMicro(value: CreditMicro): CreditMicro { return -value as CreditMicro; }

/**
 * Calculate a bounded display weight without narrowing the source amounts.
 * @param numerator - The exact segment amount.
 * @param denominator - The exact total amount.
 * @throws {RangeError} When either amount is negative.
 * @returns The converted or computed exact amount.
 */
export function creditRatio(numerator: string, denominator: string): number {
  const top = parseCreditDecimal(numerator);
  const bottom = parseCreditDecimal(denominator);
  if (top < 0n || bottom < 0n) throw new RangeError("Invalid credit ratio");
  return bottom === 0n ? 0 : Number(top * 1_000_000n / bottom) / 1_000_000;
}

export const creditDecimalSchema = z.string().regex(/^(?:0|[1-9]\d*|-[1-9]\d*|-0)\.\d{6}$/)
  .refine((value) => value !== "-0.000000", "Noncanonical credit zero")
  .transform((value) => value as CreditDecimal);
export const nonnegativeCreditDecimalSchema = creditDecimalSchema.refine((value) => parseCreditDecimal(value) >= 0n);
export const creditRowDecimalSchema = creditDecimalSchema.refine((value) => {
  const micro = parseCreditDecimal(value);
  return micro >= -CREDIT_ROW_MAX_MICRO && micro <= CREDIT_ROW_MAX_MICRO;
});
export const creditAmountFormatQuerySchema = z.object({ amountFormat: z.literal(CREDIT_AMOUNT_FORMAT) });
