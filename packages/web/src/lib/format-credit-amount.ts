// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { formatCredits, getLocale } from '@breatic/shared';

/**
 * Format a credit balance for display.
 *
 * A balance is rarely a whole number — a model's cost per call is not — and
 * the same figure appears in a Project's top bar and on its Studio's credits
 * tab. Two decimals in one place and three in the other read as two different
 * amounts of the same money, so both go through here.
 *
 * The locale is the one the language switch is set to. Leaving it out takes
 * the browser's or the operating system's instead, which is a different
 * setting and a different grouping separator.
 * @param value - The amount, in credits.
 * @returns It, grouped, with at most two decimals.
 */
export function formatCreditAmount(value: number): string {
  return formatCredits(value, getLocale());
}

/**
 * Format an amount that sits in a column of amounts, always to two decimals.
 *
 * A right-aligned column mixing "-6.3" and "-0.23" puts the decimal points one
 * digit apart, and the shorter figure reads as the smaller one.
 * @param value - The amount, in credits.
 * @returns It, grouped, with exactly two decimals.
 */
export function formatCreditColumnAmount(value: number): string {
  return formatCredits(value, getLocale(), 2);
}
