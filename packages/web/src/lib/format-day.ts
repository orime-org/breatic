// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { getLocale } from '@breatic/shared';

/**
 * Two digits, so a column of dates lines up.
 * @param n - A month or a day.
 * @returns It, zero-padded.
 */
function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Format a timestamp as the user's own date.
 *
 * The wire carries UTC. Taking the first ten characters of it shows UTC's day
 * to everyone, and a user eight hours ahead sees the day before for anything
 * stamped between midnight and 08:00 their time.
 *
 * The parts come off a local `Date`, so the day is the user's. The shape is
 * the one the confirmed design draws and it reads the same in every language
 * this product ships, which is why it is assembled rather than localised.
 * @param at - An ISO-8601 timestamp, or epoch milliseconds.
 * @returns The date in the user's timezone, as `YYYY-MM-DD`.
 */
export function formatLocalDay(at: string | number): string {
  const day = new Date(at);
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

/**
 * Format an instant as the user's own calendar day, written out in their
 * language (`2026年12月10日`, `December 10, 2026`).
 * @param at - An ISO-8601 timestamp, or epoch milliseconds.
 * @returns The day in the user's timezone and language.
 */
export function formatLongLocalDay(at: string | number): string {
  return new Date(at).toLocaleDateString(getLocale(), { year: 'numeric', month: 'long', day: 'numeric' });
}
