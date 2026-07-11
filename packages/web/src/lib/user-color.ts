// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Collaborator identity color (batch-2 item 14): maps a user id to one of the
 * 7 palette identity hues. Pure and deterministic, so every client derives
 * the SAME color for the same collaborator with zero coordination, stable
 * across sessions. Returned as a `var(--color-palette-*)` reference — the
 * palette tokens carry hand-tuned light/dark values (classification colors
 * are per-mode constants, never contrast math — user 2026-07-03).
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

/** Matches the only color form y-prosemirror's cursor validator accepts. */
const SIX_DIGIT_HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Wire-safe fallback when the palette token cannot be resolved (detached
 * documents, tests): a neutral mid gray that satisfies the 6-digit-hex shape
 * awareness payloads must carry. Never used for on-screen rendering by
 * breatic clients — they re-derive the token var from the hue.
 */
const WIRE_FALLBACK_HEX = '#888888'; // design-value: allow — wire-protocol constant, never rendered by breatic clients

/**
 * Resolves a palette hue to its CURRENT concrete hex value from the live
 * document styles. Used for the AWARENESS payload: y-prosemirror validates
 * `user.color` as a 6-digit hex (anything else console-warns on every remote
 * caret update), so the wire carries a concrete hex while breatic receivers
 * render from the whitelisted hue instead (viewer-theme adaptive).
 * @param hue - The palette hue to resolve.
 * @returns The token's current hex, or a neutral fallback when unresolvable.
 */
export function resolvePaletteHex(hue: PaletteHue): string {
  if (typeof document === 'undefined') return WIRE_FALLBACK_HEX;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(`--color-palette-${hue}`)
    .trim();
  return SIX_DIGIT_HEX.test(raw) ? raw : WIRE_FALLBACK_HEX;
}
