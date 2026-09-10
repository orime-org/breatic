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

import type { Mark, MarkType, Node as PMNode } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';

import { trimEdges, trimmedRange } from '@web/spaces/document/document-tools';
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
 * Whether a colour of this kind would land on a run of text.
 *
 * Two things keep it off. The block may take no marks at all — a code block's
 * content declares none — and a mark already on the run may exclude it: the
 * `code` mark's `excludes` is `_`, which is every other mark. A mark of this
 * kind already on the run is not one of those: every mark type excludes its own
 * kind by default, which is how a second colour replaces the first.
 * @param block - The block the run sits in.
 * @param marks - The marks already on the run.
 * @param mark - The colour mark's type.
 * @returns Whether it would land.
 */
function landsOn(
  block: PMNode,
  marks: readonly Mark[],
  mark: MarkType,
): boolean {
  return (
    block.type.allowsMarkType(mark) &&
    !marks.some((held) => held.type !== mark && held.type.excludes(mark))
  );
}

/**
 * The runs of text a colour of this kind would land on when pressed.
 *
 * Read over {@link trimmedRange} rather than over the selection, because that
 * is the range a press writes to. Reading the wider one made the panel answer
 * for text the press never reaches: a red word a reader had dragged across in
 * the ordinary way — picking up the space after it — read as two runs that
 * disagree and marked no cell at all, and a word marked as inline code plus
 * that same space drew a live panel whose every cell then did nothing.
 *
 * Three answers come off this one walk — whether the panel is live, which cell
 * is in force, and what a press will and will not touch. Alignment reads its
 * own blocks the same way (`alignableUnder`).
 * @param state - The editor state.
 * @param kind - Which row.
 * @returns The marks on each reachable run, in document order.
 */
function reachableUnder(
  state: EditorState,
  kind: ColourKind,
): readonly (readonly Mark[])[] {
  const mark = state.schema.marks[kind];
  if (mark === undefined) {
    return [];
  }
  const { empty, $from } = state.selection;
  if (empty) {
    // A caret carries the marks it would type with, which is where a style
    // pressed with no selection goes.
    const held = state.storedMarks ?? $from.marks();
    return landsOn($from.parent, held, mark) ? [held] : [];
  }
  const { from, to } = trimmedRange(state.doc, state.selection);
  const runs: (readonly Mark[])[] = [];
  state.doc.nodesBetween(from, to, (node: PMNode, _pos, parent) => {
    if (!node.isText) {
      return true;
    }
    if (parent !== null && landsOn(parent, node.marks, mark)) {
      runs.push(node.marks);
    }
    return false;
  });
  return runs;
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
  const runs = reachableUnder(editor.prosemirrorState, kind);
  // Nothing reachable is where the panel is grey, and a cell drawn in force
  // under a grey panel would speak for text no press can change.
  if (runs.length === 0) {
    return undefined;
  }
  const seen = new Set(runs.map((marks) => colourOf(marks, kind)));
  return seen.size === 1 ? [...seen][0] : undefined;
}

/**
 * Whether the panel can act on this selection.
 *
 * R7 (`document-tool-button.tsx`) asks that no control look usable and do
 * nothing. One reachable run is enough — a selection running from prose into a
 * code block still colours the prose — which is how the alignment slot judges
 * the same shape. Both rows are inline styles on the same content, so the text
 * row answers for the panel.
 * @param editor - The editor.
 * @returns Whether a press would reach anything.
 */
export function selectionCanColour(editor: ColourEditor): boolean {
  return reachableUnder(editor.prosemirrorState, 'textColor').length > 0;
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
