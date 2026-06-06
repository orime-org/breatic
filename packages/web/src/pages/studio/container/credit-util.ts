// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/** Gift lots within this many days of expiry read as "expiring soon" (spec §3.6). */
export const EXPIRY_WARNING_DAYS = 7;

/**
 * Whole days from `now` until `expiresAt`, rounded up (negative if already
 * past). Drives whether a gift credit lot shows the "expiring soon" warning
 * badge (spec §3.6). Pure (takes `now`) so it is deterministic under test.
 * @param expiresAt the lot's ISO-8601 expiry timestamp.
 * @param now the current time in epoch milliseconds.
 * @returns whole days until expiry (may be negative).
 */
export function daysUntilExpiry(expiresAt: string, now: number): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.ceil((new Date(expiresAt).getTime() - now) / msPerDay);
}

/**
 * Whether a gift lot should show the "expiring soon" warning (within the
 * warning window and not yet past).
 * @param expiresAt the lot's ISO-8601 expiry timestamp, or `null` (never).
 * @param now the current time in epoch milliseconds.
 * @returns the remaining days when expiring soon, otherwise `null`.
 */
export function expiringDays(
  expiresAt: string | null,
  now: number,
): number | null {
  if (expiresAt === null) {
    return null;
  }
  const days = daysUntilExpiry(expiresAt, now);
  return days >= 0 && days <= EXPIRY_WARNING_DAYS ? days : null;
}
