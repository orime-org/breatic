// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { ceilCreditMicroToCent, parseCreditDecimal, quantizeQuotedCredits } from "@shared/credit-amount.js";

/**
 * A credit amount written for a reader.
 *
 * A run is charged in part-credits, so they are kept, to at most two
 * decimals, rounded up the way a charge is (a debit away from zero); digits
 * group the way the locale groups them. The one rule for the panels, the
 * proposal card and the agent's own quotes.
 * @param value - The amount, in credits.
 * @param locale - The locale to write it in.
 * @param minimumFractionDigits - Decimals always written; a column of
 *   amounts passes 2 so its decimal points line up.
 * @returns The amount as text.
 */
export function formatCredits(value: number | string, locale: string, minimumFractionDigits = 0): string {
  const micro = typeof value === "string" ? parseCreditDecimal(value) : quantizeQuotedCredits(Math.abs(value)) * (value < 0 ? -1n : 1n);
  const magnitude = ceilCreditMicroToCent(micro < 0n ? -micro : micro);
  const whole = magnitude / 1_000_000n;
  const cents = Number(magnitude % 1_000_000n / 10_000n);
  const integer = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(whole);
  const fraction = new Intl.NumberFormat(locale, { minimumFractionDigits, maximumFractionDigits: 2, useGrouping: false })
    .formatToParts(cents / 100).filter((part) => part.type === "decimal" || part.type === "fraction").map((part) => part.value).join("");
  const minus = micro < 0n ? new Intl.NumberFormat(locale).formatToParts(-1).find((part) => part.type === "minusSign")!.value : "";
  return `${minus}${integer}${fraction}`;
}
