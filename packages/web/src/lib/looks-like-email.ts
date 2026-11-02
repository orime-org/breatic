// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether a trimmed string has the shape of an email address, as every form
 * that asks for one checks it before sending. The server decides the rest.
 * @param value - The text the user typed, already trimmed.
 * @returns True when it reads as `name@domain.tld`.
 */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
