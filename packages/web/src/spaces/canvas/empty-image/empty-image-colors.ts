// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Fixed fill-colour swatches for the reset-empty-image panel (#1623, D2). These
 * hex values are the literal PIXEL colour baked into the generated PNG — image
 * CONTENT, not design tokens — so each carries a `design-value: allow` escape
 * for `lint:no-raw-design-values` (a themed token would be wrong: the blank
 * canvas must be exactly the colour the user picked, in every viewer's theme).
 */

/** One preset fill colour: a stable key (i18n label) + its literal hex. */
export interface EmptyImageColor {
  key: string;
  hex: string;
}

/** Default fill colour for a fresh panel — white (D2). */
export const EMPTY_IMAGE_DEFAULT_COLOR = '#ffffff'; // design-value: allow — image content, not a theme token

/**
 * Swatch background for the custom-colour trigger — a rainbow conic gradient
 * (named CSS colours, so no raw-hex) signalling "pick any colour". It is OUR
 * `<div>`, not the native `<input type="color">` swatch (which each browser
 * renders differently), so the control looks identical on every engine.
 */
export const EMPTY_IMAGE_CUSTOM_GRADIENT =
  'conic-gradient(red, orange, yellow, lime, cyan, blue, magenta, red)';

/** The fixed swatch row; white first (default), then neutrals and solids. */
export const EMPTY_IMAGE_COLORS: ReadonlyArray<EmptyImageColor> = [
  { key: 'white', hex: '#ffffff' }, // design-value: allow — image content, not a theme token
  { key: 'lightGray', hex: '#d9d9d9' }, // design-value: allow — image content, not a theme token
  { key: 'gray', hex: '#808080' }, // design-value: allow — image content, not a theme token
  { key: 'black', hex: '#000000' }, // design-value: allow — image content, not a theme token
  { key: 'red', hex: '#ef4444' }, // design-value: allow — image content, not a theme token
  { key: 'orange', hex: '#f97316' }, // design-value: allow — image content, not a theme token
  { key: 'yellow', hex: '#eab308' }, // design-value: allow — image content, not a theme token
  { key: 'green', hex: '#22c55e' }, // design-value: allow — image content, not a theme token
  { key: 'blue', hex: '#3b82f6' }, // design-value: allow — image content, not a theme token
  { key: 'violet', hex: '#8b5cf6' }, // design-value: allow — image content, not a theme token
];
