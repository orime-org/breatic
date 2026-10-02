// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A translated sentence with React nodes in it. `t()` interpolates a unique
 * marker for each slot; the localized string is then split on the markers and
 * each slot's node is dropped in at the position the language puts it.
 */

import * as React from 'react';

/** A NUL control char — never present in any user-facing locale string. */
const SLOT_DELIM = String.fromCodePoint(0);
/** Matches `<NUL>name<NUL>` markers, capturing the slot name. */
const SLOT_PATTERN = new RegExp(`${SLOT_DELIM}(\\w+)${SLOT_DELIM}`);

/**
 * Build the marker `t()` interpolates for a slot — split back out at render.
 * @param name - The slot name, matching the `{placeholder}` in the translated string.
 * @returns The delimited marker string.
 */
export function slotMarker(name: string): string {
  return `${SLOT_DELIM}${name}${SLOT_DELIM}`;
}

/**
 * Split a localized string carrying slot markers and interpolate each slot's
 * React node at its marker position. Even indices are literal text; odd indices
 * are slot names resolved against `nodes`.
 * @param text - The localized string with `slotMarker(...)` markers embedded.
 * @param nodes - The React node to render for each slot name.
 * @returns The interleaved text + node sequence.
 */
export function renderSlottedText(
  text: string,
  nodes: Record<string, React.ReactNode>,
): React.ReactNode[] {
  return text.split(SLOT_PATTERN).map((part, i) =>
    i % 2 === 1 ? (
      <React.Fragment key={i}>{nodes[part] ?? ''}</React.Fragment>
    ) : (
      <React.Fragment key={i}>{part}</React.Fragment>
    ),
  );
}
