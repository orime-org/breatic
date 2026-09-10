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

/** One row's answers, filled in as the walk goes. */
interface RowTally {
  readonly kind: ColourKind;
  readonly mark: MarkType | undefined;
  reached: boolean;
  readonly hues: Set<string>;
}

/**
 * Adds one run of text to a row's tally, where that row reaches it.
 * @param row - The row's tally.
 * @param block - The block the run sits in.
 * @param marks - The marks on the run.
 */
function note(row: RowTally, block: PMNode, marks: readonly Mark[]): void {
  if (row.mark === undefined || !landsOn(block, marks, row.mark)) {
    return;
  }
  row.reached = true;
  row.hues.add(colourOf(marks, row.kind));
}

/**
 * A row's cell in force.
 * @param row - The row's tally.
 * @returns The one hue every run it reached carries, or nothing where they
 *   disagree or it reached none — a cell drawn in force under a grey panel
 *   would speak for text no press can change.
 */
function inForce(row: RowTally): string | undefined {
  return row.hues.size === 1 ? [...row.hues][0] : undefined;
}

/**
 * Everything the colour panel draws, off one walk of the range a press covers.
 *
 * The walk runs over {@link trimmedRange} rather than over the selection,
 * because that is the range a press writes to. Reading the wider one made the
 * panel answer for text the press never reaches: a red word a reader had
 * dragged across in the ordinary way — picking up the space after it — read as
 * two runs that disagree and marked no cell at all, and a word marked as
 * inline code plus that same space drew a live panel whose every cell then did
 * nothing.
 *
 * Both rows are tallied in the one walk, and the slot subscribes to this once,
 * the way the alignment slot subscribes to `alignFace`. Read a row at a time,
 * the panel walked the selection three times per editor change and the three
 * readings could disagree about what is under it.
 * @param editor - The editor.
 * @returns What the slot and its panel draw.
 */
export function colourFace(editor: ColourEditor): ColourFace {
  const state = editor.prosemirrorState;
  const rows: readonly RowTally[] = (
    ['textColor', 'backgroundColor'] as const
  ).map((kind) => ({
    kind,
    mark: state.schema.marks[kind],
    reached: false,
    hues: new Set<string>(),
  }));
  const { empty, $from } = state.selection;
  if (empty) {
    // A caret carries the marks it would type with, which is where a style
    // pressed with no selection goes.
    const held = state.storedMarks ?? $from.marks();
    rows.forEach((row) => {
      note(row, $from.parent, held);
    });
  } else {
    const { from, to } = trimmedRange(state.doc, state.selection);
    state.doc.nodesBetween(from, to, (node: PMNode, _pos, parent) => {
      if (!node.isText) {
        return true;
      }
      if (parent !== null) {
        rows.forEach((row) => {
          note(row, parent, node.marks);
        });
      }
      return false;
    });
  }
  const [text, fill] = rows as readonly [RowTally, RowTally];
  return {
    appliesHere: text.reached || fill.reached,
    text: inForce(text),
    fill: inForce(fill),
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
