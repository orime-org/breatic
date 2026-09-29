// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Spell ASCII text in Unicode tag characters, the way an instruction is hidden
 * inside text a person reads.
 * @param ascii - The text to hide.
 * @returns The same text as invisible tag characters.
 */
export function hiddenInTags(ascii: string): string {
  return [...ascii].map((c) => String.fromCodePoint(0xe0000 + c.codePointAt(0)!)).join("");
}

/** Matches any Unicode tag character. */
export const TAG_CHARACTER = /[\u{E0000}-\u{E007F}]/u;
