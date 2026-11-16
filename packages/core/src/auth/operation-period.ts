// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The monthly operations period (inner#1968, design 3.5).
 *
 * Every period start is pushed straight from the anchor, never from the
 * previous period: the k-th start is the anchor plus k calendar months, its
 * day clamped to that month's length and its time of day the anchor's. A
 * 31st anchor therefore falls on the 28th (29th) in February and is back on
 * the 31st in March, as Stripe's billing cycle does. All arithmetic is UTC.
 */

/** One half-open period, `[start, end)`. */
export interface OperationPeriod {
  /** The first instant of the period. */
  readonly start: Date;
  /** The first instant of the next period. */
  readonly end: Date;
}

/**
 * The anchor moved by whole calendar months, its day clamped to the target month.
 * @param anchor - The anchor instant.
 * @param months - How many months to move; negative moves backwards.
 * @returns The k-th period start.
 */
function addMonthsClamped(anchor: Date, months: number): Date {
  const total = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const msOfDay = anchor.getTime() - Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate());
  return new Date(Date.UTC(year, month, Math.min(anchor.getUTCDate(), last)) + msOfDay);
}

/**
 * The period of an anchor that contains `now`.
 * @param anchor - When the periods are counted from; may be after `now`.
 * @param now - The instant to place.
 * @returns The period with `start <= now < end`.
 */
export function periodContaining(anchor: Date, now: Date): OperationPeriod {
  let k = (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + now.getUTCMonth() - anchor.getUTCMonth();
  while (addMonthsClamped(anchor, k).getTime() > now.getTime()) k--;
  while (addMonthsClamped(anchor, k + 1).getTime() <= now.getTime()) k++;
  return { start: addMonthsClamped(anchor, k), end: addMonthsClamped(anchor, k + 1) };
}
