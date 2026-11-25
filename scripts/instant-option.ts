// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/** An absolute instant: date, time and an explicit zone. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Read a command-line instant, which must name its zone so a script run on
 * another machine means the same moment.
 * @param flag - The flag it was given under, for the error.
 * @param value - The text after the flag.
 * @returns The instant.
 * @throws {Error} When the text is not an ISO instant with a zone.
 */
export function parseInstant(flag: string, value: string): Date {
  const at = new Date(value);
  if (!INSTANT.test(value) || Number.isNaN(at.getTime())) {
    throw new Error(`${flag} ${value} is not an ISO instant with a zone (2026-11-20T10:00:00Z)`);
  }
  return at;
}
