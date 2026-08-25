// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Collaborator identity color (batch-2 item 14): maps a user id to one of the
 * 7 palette identity hues. Pure and deterministic, so every client derives
 * the SAME color for the same collaborator with zero coordination, stable
 * across sessions. Returned as a `var(--color-palette-*)` reference — the
 * palette tokens carry hand-tuned light/dark values (classification colors
 * are per-mode constants, never contrast math — user 2026-07-03).
 *
 * The token reference, rather than a resolved value, is also what lets two
 * people in different themes each see the colour their own theme defines.
 */

/** The 7 palette identity hues, in token order (theme/tokens.css). */
export const PALETTE_HUES = [
  'red',
  'orange',
  'green',
  'blue',
  'violet',
  'pink',
  'teal',
] as const;

/** One of the 7 palette identity hues. */
export type PaletteHue = (typeof PALETTE_HUES)[number];

/**
 * Deterministically resolves a user's identity hue from their id via a
 * 32-bit FNV-1a hash over the id's UTF-16 code units.
 * @param userId - The user id (any string; empty is allowed).
 * @returns One of the 7 palette hues.
 */
export function userPaletteHue(userId: string): PaletteHue {
  let hash = 0x811c9dc5;
  for (let i = 0; i < userId.length; i += 1) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return PALETTE_HUES[hash % PALETTE_HUES.length];
}

/**
 * A user's identity color as a token reference for LOCAL rendering — the
 * viewer's own theme resolves the light/dark value.
 * @param userId - The user id.
 * @returns A `var(--color-palette-<hue>)` CSS reference.
 */
export function userPaletteColor(userId: string): string {
  return `var(--color-palette-${userPaletteHue(userId)})`;
}

// Nothing here resolves a hue to a concrete hex any more. That existed to put
// a colour ON THE WIRE — y-prosemirror validates `user.color` as a 6-digit hex
// — and #1882 stopped publishing a colour at all: awareness carries the user
// id, and every client derives the same hue from it locally. Reintroducing a
// hex here would mean reintroducing a colour on the wire, which is the thing
// that made a caret's colour depend on whichever tab published last.
