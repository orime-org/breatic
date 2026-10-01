// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Whether a time zone a browser reported is one we can show a time in.
 *
 * It reaches us in a request body, so it is checked before anything uses it.
 * The check asks the one thing that matters downstream — whether `Intl` will
 * format a time in it — since that is what every caller does with it. Asking a
 * list of canonical names instead would turn away the legacy links `Intl`
 * still accepts.
 * @param timeZone - What the client said.
 * @returns True when `Intl` formats a time in that zone.
 */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
}
