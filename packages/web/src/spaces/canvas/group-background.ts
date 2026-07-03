// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The group background palette (#1549) — a purely human-chosen classification
 * tint with no system semantics: the full 7-color palette (each color's
 * 14%-opacity `-bg` token) plus no color (no tint → neutral dashed frame).
 * Options are keyed by plain color name — the picker IS a color choice, not a
 * status choice (the pre-#1549 i18n labels already said "Blue/Green/…").
 */

/** One choice in the group background picker. */
export interface GroupBackgroundOption {
  /** Stable short id (react key / testid), independent of the token name. */
  key: string;
  /** Stored design token name, or `undefined` for no color (clears the tint). */
  value: string | undefined;
  /** i18n key for the option's accessible label. */
  labelKey: string;
}

/** no color + the 7 palette tints, in spec order. */
export const GROUP_BACKGROUND_OPTIONS: ReadonlyArray<GroupBackgroundOption> = [
  { key: 'none', value: undefined, labelKey: 'canvas.group.backgroundNone' },
  { key: 'red', value: '--color-palette-red-bg', labelKey: 'canvas.group.backgroundRed' },
  { key: 'orange', value: '--color-palette-orange-bg', labelKey: 'canvas.group.backgroundOrange' },
  { key: 'green', value: '--color-palette-green-bg', labelKey: 'canvas.group.backgroundGreen' },
  { key: 'blue', value: '--color-palette-blue-bg', labelKey: 'canvas.group.backgroundBlue' },
  { key: 'violet', value: '--color-palette-violet-bg', labelKey: 'canvas.group.backgroundViolet' },
  { key: 'pink', value: '--color-palette-pink-bg', labelKey: 'canvas.group.backgroundPink' },
  { key: 'teal', value: '--color-palette-teal-bg', labelKey: 'canvas.group.backgroundTeal' },
];

/**
 * Pre-#1549 stored token names → their palette successors. Groups persist the
 * token NAME in the Yjs doc, so documents saved under the 4-status palette
 * still carry these strings forever — mapping them here (instead of a data
 * migration) keeps old docs rendering the ratified colors with zero writes.
 */
export const LEGACY_GROUP_BACKGROUND_ALIASES: Readonly<Record<string, string>> = {
  '--color-status-info-bg': '--color-palette-blue-bg',
  '--color-status-success-bg': '--color-palette-green-bg',
  '--color-status-warning-bg': '--color-palette-orange-bg',
  '--color-status-error-bg': '--color-palette-red-bg',
};

/**
 * Resolve a stored group background value to its current palette token —
 * legacy status tokens map to their successor, everything else (current
 * tokens, no color) passes through unchanged. All rendering and selection
 * matching goes through this, so old and new documents behave identically.
 * @param value - The stored token name, or `undefined` for no color.
 * @returns The current token name, or `undefined` when untinted.
 */
export function normalizeGroupBackground(
  value: string | undefined,
): string | undefined {
  return value ? (LEGACY_GROUP_BACKGROUND_ALIASES[value] ?? value) : undefined;
}

/**
 * The CSS `background-color` for a stored group token. The token name is
 * stored (a stable id); the render layer normalizes legacy names and applies
 * `var()`. no color (no stored token) maps to `undefined` so the container
 * shows no fill.
 * @param value - The stored token name, or `undefined` for no color.
 * @returns The `var(...)` color string, or `undefined` when untinted.
 */
export function groupBackgroundStyle(
  value: string | undefined,
): string | undefined {
  const token = normalizeGroupBackground(value);
  return token ? `var(${token})` : undefined;
}

/**
 * The CSS `border-color` for a tinted group — the matching 40% `-border`
 * sibling of the stored `-bg` token. Calibration finding (#1549): dark-mode
 * tints alone are hard to tell apart, so a tinted group's dashed border
 * carries the same hue as a second identity anchor. Untinted groups return
 * `undefined` and keep the neutral dashed border.
 * @param value - The stored token name, or `undefined` for no color.
 * @returns The `var(...)` border color string, or `undefined` when untinted.
 */
export function groupBorderStyle(
  value: string | undefined,
): string | undefined {
  const token = normalizeGroupBackground(value);
  return token ? `var(${token.replace(/-bg$/, '-border')})` : undefined;
}

/**
 * The CSS color for a picker swatch dot — the SOLID identity color behind the
 * stored `-bg` token. Calibration finding (#1549, Chrome model): selection
 * swatches must use the full-strength identity (tint dots are near-identical
 * in dark mode); the tint is applied only to the group surface itself.
 * @param value - The stored token name, or `undefined` for no color.
 * @returns The `var(...)` identity color string, or `undefined` for no color.
 */
export function groupSwatchStyle(
  value: string | undefined,
): string | undefined {
  const token = normalizeGroupBackground(value);
  return token ? `var(${token.replace(/-bg$/, '')})` : undefined;
}
