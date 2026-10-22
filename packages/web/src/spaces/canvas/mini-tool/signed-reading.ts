// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A value that runs both ways, as the audio panels read it (inner#1305): a plus
 * above 0, a true minus below it, and plain 0, so readings in a column line
 * up with the static labels that write −14 LUFS.
 * @param value - The value.
 * @returns The reading.
 */
export function signedReading(value: number): string {
  if (value > 0) return `+${value}`;
  if (value < 0) return `−${-value}`;
  return '0';
}
