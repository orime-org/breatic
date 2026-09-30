// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A credit amount written for a reader.
 *
 * A run is charged in part-credits, so they are kept, to at most two
 * decimals; digits group the way the locale groups them. The one rule for
 * the panels, the proposal card and the agent's own quotes.
 * @param value - The amount, in credits.
 * @param locale - The locale to write it in.
 * @returns The amount as text.
 */
export function formatCredits(value: number, locale: string): string {
  return value.toLocaleString(locale, { maximumFractionDigits: 2 });
}
