// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Turning the membership numbers into something a person reads.
 *
 * The ceilings arrive exactly as `config/membership.yaml` holds them, which
 * for storage means bytes — `5368709120` rather than `5 GiB`. Every value in
 * that file was written as a whole number of GiB or TiB, so displaying it
 * means putting it back into the unit somebody wrote it in.
 */

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

/**
 * Render a byte count in the largest binary unit that leaves it above one.
 *
 * Binary units and not decimal ones, because the configured values are
 * binary: `5 GiB` in the file is `5 * 1024³`, and calling that "5.4 GB" would
 * print a number nobody wrote. A whole value stays whole (`200 GiB`); a
 * measured one, which usage always is, keeps one decimal (`38.4 GiB`).
 * @param bytes - A non-negative byte count.
 * @returns The count with its unit, for example `200 GiB` or `38.4 GiB`.
 */
export function formatBytes(bytes: number): string {
  let index = 0;
  let value = bytes;
  while (value >= 1024 && index < UNITS.length - 1) {
    value /= 1024;
    index += 1;
  }
  // `Number()` drops a trailing `.0`, so a whole number of GiB reads as the
  // integer somebody configured rather than as a measurement.
  let shown = Number(value.toFixed(1));
  // Rounding can push the figure up to a number its unit does not have:
  // 1048575 bytes is 1023.999 KiB, which rounds to "1024 KiB" — a reading this
  // scale never produces. Carrying it into the next unit is what the promise
  // above ("the largest unit that leaves it above one") actually says.
  if (shown >= 1024 && index < UNITS.length - 1) {
    shown = 1;
    index += 1;
  }
  return `${shown} ${UNITS[index]}`;
}

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
