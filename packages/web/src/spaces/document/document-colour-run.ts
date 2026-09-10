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
 *   `document-tools.ts` records why: `getActiveStyles()` reads the marks at
 *   `$to` alone, so a half-coloured selection answers by whichever end the
 *   drag finished on. Here that would mark a hue no part of the selection may
 *   carry, or mark "default" over a run that is half red.
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

import { toggleMark } from '@tiptap/pm/commands';
import type { Mark, Node as PMNode } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';

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
 * Every colour this row carries across the selection.
 * @param state - The editor state.
 * @param kind - Which row.
 * @returns One entry per distinct colour, {@link NO_COLOUR} included.
 */
function coloursUnder(
  state: EditorState,
  kind: ColourKind,
): ReadonlySet<string> {
  const { from, to, empty, $from } = state.selection;
  if (empty) {
    // A caret carries the marks it would type with, which is where a style
    // pressed with no selection goes.
    return new Set([colourOf(state.storedMarks ?? $from.marks(), kind)]);
  }
  const seen = new Set<string>();
  state.doc.nodesBetween(from, to, (node: PMNode) => {
    if (!node.isText) {
      return true;
    }
    seen.add(colourOf(node.marks, kind));
    return false;
  });
  // A selection holding no text at all — an empty block — carries no colour.
  return seen.size === 0 ? new Set([NO_COLOUR]) : seen;
}

/**
 * The colour the whole selection carries on that row.
 * @param editor - The editor.
 * @param kind - Which row.
 * @returns The hue, {@link NO_COLOUR} where the selection carries none, or
 *   nothing where its parts disagree — which leaves every cell unmarked.
 */
export function activeColour(
  editor: ColourEditor,
  kind: ColourKind,
): string | undefined {
  const seen = coloursUnder(editor.prosemirrorState, kind);
  return seen.size === 1 ? [...seen][0] : undefined;
}

/**
 * Whether the panel can act on this selection.
 *
 * A dry run of the mark against the schema, the way the four marks answer
 * (`document-tool-button.tsx`, R7). Both rows are inline styles on the same
 * content, so one answers for the panel.
 * @param editor - The editor.
 * @returns Whether a press would reach anything.
 */
export function selectionCanColour(editor: ColourEditor): boolean {
  const mark = editor.pmSchema.marks['textColor'];
  return mark !== undefined && editor.canExec(toggleMark(mark));
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
  // `removeStyles` reads the keys, not the values, so the empty strings here
  // are what BlockNote's own colour button passes.
  const off = Object.fromEntries(kinds.map((kind) => [kind, '']));
  editor.removeStyles(off as never);
}
