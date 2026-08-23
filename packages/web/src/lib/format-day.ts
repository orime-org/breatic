// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Two digits, so a column of dates lines up.
 * @param n - A month or a day.
 * @returns It, zero-padded.
 */
function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Format a timestamp as the reader's own date.
 *
 * The wire carries UTC. Taking the first ten characters of it shows UTC's day
 * to everyone, and a reader eight hours ahead spends a third of every day on
 * the one before — on a record of money, where this is the only time it
 * carries.
 *
 * The parts come off a local `Date`, so the day is the reader's. The shape is
 * the one the confirmed design draws and it reads the same in every language
 * this product ships, which is why it is assembled rather than localised.
 * @param iso - An ISO-8601 timestamp.
 * @returns The date in the reader's timezone, as `YYYY-MM-DD`.
 */
export function formatLocalDay(iso: string): string {
  const at = new Date(iso);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}
