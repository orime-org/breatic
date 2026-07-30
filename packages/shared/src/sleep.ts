// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Wait for a duration.
 *
 * Shared so the retry loop and the poll loop cannot drift into two
 * slightly different timers.
 * @param ms - Milliseconds to wait.
 * @returns A promise that resolves once the delay has elapsed.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
