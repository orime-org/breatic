// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What pressing a colour cell does to the selection, which cell reads as the
 * one in force, and when the panel can act at all.
 *
 * A colour is one of BlockNote's own inline styles, so a press is `addStyles`
 * or `removeStyles`. The three answers here are the ones the four marks on the
 * same bar already give, applied to a style that carries a value:
 *
 * - The cell in force speaks for the WHOLE selection.
 *   `document-tools.ts` records why the marks stopped reading
 *   `getActiveStyles()`: it takes the marks at `$to` alone. Here that would
 *   mark the hue of the selection's last run over one that is half red, or
 *   mark "default" over one whose last run happens to be plain.
 * - A press covers the selection minus its whitespace edges, through the same
 *   `trimEdges` the marks go through.
 * - The panel is unavailable where no block under the selection takes marks
 *   (R7, `document-tool-button.tsx`): a code block takes none, so every cell
 *   would be a press with nothing behind it.
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
  pressReaches,
  readAcrossSelection,
  styleReading,
  type StyleReading,
} from '@web/spaces/document/document-style-range';
import { trimEdges } from '@web/spaces/document/document-tools';
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
 * from a selection whose parts disagree, where no cell is in force.
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
 * How one colour row reads off a run of text.
 * @param editor - The editor, for its schema.
 * @param kind - Which row.
 * @returns The reading, or nothing where this build has no such mark.
 */
function colourReading(
  editor: ColourEditor,
  kind: ColourKind,
): StyleReading<string> | undefined {
  return styleReading(
    editor.prosemirrorState,
    kind,
    (marks) => colourOf(marks, kind),
    NO_COLOUR,
  );
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
   * The text row's cell in force: a hue, {@link NO_COLOUR} where the range
   * carries none, or nothing where its runs disagree, which leaves every cell
   * of that row unmarked.
   */
  readonly text: string | undefined;
  /** The fill row's, read the same way. */
  readonly fill: string | undefined;
}

/**
 * Everything the colour panel draws, off the readings in
 * `document-style-range.ts`.
 *
 * Which cell is in force speaks for the whole highlight, so a space the reader
 * can see tinted counts and a space carrying nothing does not. Whether the
 * panel is live is judged on the range a press lands in, which is that
 * highlight minus its whitespace edges.
 *
 * The slot subscribes to this once, the way the alignment slot subscribes to
 * `alignFace`. Read a row at a time, the panel walked the selection three
 * times per editor change and the three readings could disagree about what is
 * under it.
 * @param editor - The editor.
 * @returns What the slot and its panel draw.
 */
export function colourFace(editor: ColourEditor): ColourFace {
  const state = editor.prosemirrorState;
  const text = colourReading(editor, 'textColor');
  const fill = colourReading(editor, 'backgroundColor');
  return {
    // Both rows are inline styles on the same content, so where one row can
    // act the other can too; either answering yes is enough for the panel.
    appliesHere:
      (text !== undefined && pressReaches(state, text)) ||
      (fill !== undefined && pressReaches(state, fill)),
    text: text && readAcrossSelection(state, text),
    fill: fill && readAcrossSelection(state, fill),
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
  trimEdges(editor);
  editor.addStyles({ [kind]: hue } as never);
}

/**
 * Takes the given rows' colours off the selection.
 *
 * Covers exactly what the reader highlighted, as taking a mark off does — the
 * trim is for a press that adds.
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
