// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What pressing a colour cell does to the selection, and which cell the panel
 * marks as the one in force.
 *
 * A colour is one of BlockNote's own inline styles, so both are its API:
 * `addStyles` to set one, `removeStyles` to take it off, `getActiveStyles` to
 * read what the selection carries. What is here is the shape of the panel — a
 * hue cell, a cell that means "none", and a button that clears both — against
 * that API, so the six places that press a cell do not each have to know which
 * of the two calls their cell needs.
 *
 * What the reader then sees is `index.css`: BlockNote renders the style as a
 * `data-value` and paints five of our seven names in Notion's own hex, so the
 * hues are painted from the palette there.
 *
 * The names stored are ours (`violet` and `teal` among them) rather than
 * BlockNote's nine. Mapping onto those cannot be finished — it has no name for
 * `teal` — and these seven are the palette the panel offers.
 */

import type { BlockNoteEditor } from '@blocknote/core';

/** Which of the two rows a cell belongs to. */
export type ColourKind = 'textColor' | 'backgroundColor';

/** The editor object these read and write. */
export type ColourEditor = BlockNoteEditor<never, never, never>;

/**
 * The colour the selection carries on that row.
 * @param editor - The editor.
 * @param kind - Which row.
 * @returns The hue, or nothing where the selection carries none — which is
 *   what marks the row's default cell as the one in force.
 */
export function activeColour(
  editor: ColourEditor,
  kind: ColourKind,
): string | undefined {
  const styles = editor.getActiveStyles() as Record<string, unknown>;
  const held = styles[kind];
  return typeof held === 'string' ? held : undefined;
}

/**
 * Puts a colour on the selection, or takes the row's colour off.
 * @param editor - The editor.
 * @param kind - Which row.
 * @param hue - The hue, or nothing for the row's default cell.
 */
export function runColour(
  editor: ColourEditor,
  kind: ColourKind,
  hue?: string,
): void {
  if (hue === undefined) {
    // `removeStyles` reads the keys, not the values, so the empty string here
    // is what BlockNote's own colour button passes.
    editor.removeStyles({ [kind]: '' } as never);
    return;
  }
  editor.addStyles({ [kind]: hue } as never);
}

/**
 * Takes both colours off the selection.
 * @param editor - The editor.
 */
export function clearColours(editor: ColourEditor): void {
  editor.removeStyles({ textColor: '', backgroundColor: '' } as never);
}
