// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Turning the membership numbers into something a person reads.
 *
 * A byte count is not one of them: `formatBytes` reads the same ceilings but
 * the canvas shows one too, so it lives in `lib/format-bytes.ts`.
 */

/**
 * How full a progress bar should be drawn.
 *
 * Capped at one: an account can sit above its own ceiling — limits are judged
 * when an action happens and never applied backwards — and the figures beside
 * the bar report that honestly, but a bar cannot be drawn past its end.
 *
 * A ceiling of zero is a real ceiling rather than a missing one (`base` grants
 * zero team studios), so it does not divide: anything used against it is full,
 * nothing used against it is empty.
 * @param used - How much is spent.
 * @param limit - The ceiling it is spent against.
 * @returns A number from 0 to 1.
 */
export function usageRatio(used: number, limit: number): number {
  if (limit <= 0) return used > 0 ? 1 : 0;
  return Math.min(1, used / limit);
}

/**
 * Writes a price the way the reader's locale writes money.
 *
 * The currency comes from the server beside the amount, because which currency
 * a plan is sold in is a fact about the plan, not about who is looking at it.
 * Hard-coding a symbol throws that fact away, and dividing by 100 into a
 * string drops a trailing zero — 1250 would read as "12.5", which is not how
 * money is written anywhere.
 * @param amountCents - The price in the currency's smallest unit.
 * @param currency - Its ISO 4217 code, as the server supplies it.
 * @param locale - Which locale's conventions to write it in.
 * @returns The formatted price.
 */
export function formatPrice(
  amountCents: number,
  currency: string,
  locale: string,
): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amountCents / 100);
}
