// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What pressing a colour cell does to the selection, which cell reads as the
 * one in force, and when the panel can act at all.
 *
 * A colour is one of BlockNote's own inline styles, so a press is `addStyles`
 * or `removeStyles`, covering exactly what the reader highlighted.
 *
 * - The cell in force is the first run the selection covers
 *   (`firstRunValue`), which is how a value command reads (design §5.2).
 * - The panel is unavailable where no run under the selection could take a
 *   colour (R7, `document-tool-button.tsx`): a code block takes no marks, so
 *   every cell would be a press with nothing behind it.
 *
 * What the reader then sees is `index.css`: BlockNote renders the style as a
 * `data-value` and paints five of our seven names in Notion's own hex, so the
 * hues are painted from the palette there.
 *
 * The names stored are ours (`violet` and `teal` among them) rather than
 * BlockNote's nine. Mapping onto those cannot be finished — it has no name for
 * `teal` — and these seven are the palette the panel offers.
 */

import type { Mark } from '@tiptap/pm/model';

import {
  firstRunValue,
  markTypeOf,
  reachesAnyRun,
} from '@web/spaces/document/document-style-range';
import type { ToolEditor } from '@web/spaces/document/document-tool-button';

/**
 * The seven hues the panel offers, from demo 3.5 and the palette (user
 * 2026-08-21).
 *
 * The one place they are written. The panel draws a cell per name, the
 * stylesheet carries a rule per name, and `document-inline-colour-in-css.test`
 * reads this list to assert the second follows the first — so an eighth hue
 * added here turns that test red rather than shipping a cell that paints
 * nothing.
 */
export const COLOUR_HUES = [
  'red',
  'orange',
  'green',
  'blue',
  'violet',
  'pink',
  'teal',
] as const;

/** Which of the two rows a cell belongs to. */
export type ColourKind = 'textColor' | 'backgroundColor';

/** The editor object these read and write. */
export type ColourEditor = ToolEditor;

/**
 * What a row reads as when the selection carries no colour on it.
 *
 * A value rather than the absence of one, because "no colour" is a cell of its
 * own — the plain `A` and the crossed-out square — and it has to be told apart
 * from a selection no colour could reach, where no cell is in force.
 */
export const NO_COLOUR = 'none';

/**
 * The value one mark of this kind carries.
 * @param marks - The marks on one run of text.
 * @param kind - Which row.
 * @returns The hue, or {@link NO_COLOUR} where this row is not on it.
 */
function colourOf(marks: readonly Mark[], kind: ColourKind): string {
  const held = marks.find((mark) => mark.type.name === kind);
  const value: unknown = held?.attrs['stringValue'];
  return typeof value === 'string' ? value : NO_COLOUR;
}

/**
 * The cell in force on one row.
 * @param editor - The editor.
 * @param kind - Which row.
 * @returns The hue, {@link NO_COLOUR} where the first run carries none, or
 *   nothing where no run under the selection could take a colour at all.
 */
function cellInForce(
  editor: ColourEditor,
  kind: ColourKind,
): string | undefined {
  const state = editor.prosemirrorState;
  const mark = markTypeOf(state, kind);
  return mark === undefined
    ? undefined
    : firstRunValue(state, mark, (marks) => colourOf(marks, kind));
}

/** Everything the colour panel draws, off one reading of the selection. */
export interface ColourFace {
  /**
   * Whether a press would reach anything.
   *
   * R7 (`document-tool-button.tsx`) asks that no control look usable and do
   * nothing. One reachable run is enough — a selection running from prose into
   * a code block still colours the prose — which is how the alignment slot
   * judges the same shape.
   */
  readonly appliesHere: boolean;
  /**
   * The text row's cell in force: the first run's hue, {@link NO_COLOUR} where
   * that run carries none, or nothing where no run under the selection could
   * take a colour at all, which leaves every cell of that row unmarked.
   */
  readonly text: string | undefined;
  /** The fill row's, read the same way. */
  readonly fill: string | undefined;
}

/**
 * Everything the colour panel draws.
 *
 * The slot subscribes to this once, the way the alignment slot subscribes to
 * `alignFace`.
 * @param editor - The editor.
 * @returns What the slot and its panel draw.
 */
export function colourFace(editor: ColourEditor): ColourFace {
  const state = editor.prosemirrorState;
  const text = markTypeOf(state, 'textColor');
  const fill = markTypeOf(state, 'backgroundColor');
  return {
    appliesHere:
      (text !== undefined && reachesAnyRun(state, text)) ||
      (fill !== undefined && reachesAnyRun(state, fill)),
    text: cellInForce(editor, 'textColor'),
    fill: cellInForce(editor, 'backgroundColor'),
  };
}

/**
 * Puts a colour on the selection.
 * @param editor - The editor.
 * @param kind - Which row.
 * @param hue - One of {@link COLOUR_HUES}.
 */
export function setColour(
  editor: ColourEditor,
  kind: ColourKind,
  hue: string,
): void {
  editor.addStyles({ [kind]: hue } as never);
}

/**
 * Takes the given rows' colours off the selection.
 *
 * Covers exactly what the reader highlighted.
 * @param editor - The editor.
 * @param kinds - Which rows. One for a row's own default cell, both for the
 *   reset button.
 */
export function clearColours(
  editor: ColourEditor,
  ...kinds: readonly ColourKind[]
): void {
  // `removeStyles` reads the keys and ignores the values, so what stands here
  // says only which rows to clear.
  const off = Object.fromEntries(kinds.map((kind) => [kind, '']));
  editor.removeStyles(off as never);
}
