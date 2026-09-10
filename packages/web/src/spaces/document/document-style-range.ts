// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which text a style press acts on, and which text its control speaks for.
 *
 * Those are two different ranges, and reading one off the other is what put
 * three separate wrong answers on the bar:
 *
 * - A press that ADDS a style covers the selection minus the whitespace at its
 *   ends ({@link trimmedRange}). A reader dragging over a word picks up the
 *   space after it more often than not, and the style is meant for the word.
 * - What the control SAYS speaks for the whole highlight
 *   ({@link readAcrossSelection}), because that is what the reader is looking
 *   at. A space they can see tinted is part of what they asked about; a space
 *   carrying nothing is not something they were asking about at all, so it
 *   does not make the answer "these disagree".
 *
 * Every style on the bar reads through here: the five marks and the colour
 * panel's two rows. Judged on the press range, an unlit Bold took bold off a
 * word, and the colour panel drew "no fill" as the one in force over a
 * selection holding a tinted space — then cleared it.
 */

import type { Mark, MarkType, Node as PMNode } from '@tiptap/pm/model';
import type { EditorState, Selection } from '@tiptap/pm/state';

/**
 * The range a press that ADDS a style covers.
 *
 * Each end is measured against its own run, so between them they can cover
 * every character the reader highlighted: two spaces with a mark boundary
 * between them trim to an empty range, and a line's trailing space plus the
 * next line's leading one trim to a range holding nothing but the boundary
 * between the two blocks. A selection that is nothing but whitespace is the
 * whitespace the reader meant, so it comes back whole.
 * @param doc - The document, to see what the trimmed range would hold.
 * @param selection - The selection to pull in.
 * @returns The range, which is the selection itself where there is nothing to
 *   trim against, or nothing left to act on if it were trimmed.
 */
export function trimmedRange(
  doc: PMNode,
  selection: Selection,
): { from: number; to: number } {
  const { $from, $to, empty } = selection;
  const whole = { from: $from.pos, to: $to.pos };
  // Ends that resolve outside inline content — a select-all, whose ends are
  // the document itself — have no runs to trim against.
  if (empty || !$from.parent.inlineContent || !$to.parent.inlineContent) {
    return whole;
  }
  const opening = $from.nodeAfter;
  const closing = $to.nodeBefore;
  const lead =
    opening?.isText === true ? /^\s*/.exec(opening.text ?? '')![0].length : 0;
  const trail =
    closing?.isText === true ? /\s*$/.exec(closing.text ?? '')![0].length : 0;
  const from = $from.pos + lead;
  const to = $to.pos - trail;
  if (from >= to) {
    return whole;
  }
  let holdsText = false;
  doc.nodesBetween(from, to, (node) => {
    holdsText ||= node.isText;
    return !holdsText;
  });
  return holdsText ? { from, to } : whole;
}

/**
 * Whether a style would land on a run of text.
 *
 * Two things keep it off. The block may take no marks at all — a code block's
 * content declares none — and a mark already on the run may exclude it: the
 * `code` mark's `excludes` is `_`, which is every other mark. A mark of the
 * same type already on the run is not one of those: every mark type excludes
 * its own kind by default, which is how a second colour replaces the first.
 * @param block - The block the run sits in.
 * @param marks - The marks already on the run.
 * @param mark - The style's mark type.
 * @returns Whether it would land.
 */
export function landsOn(
  block: PMNode,
  marks: readonly Mark[],
  mark: MarkType,
): boolean {
  return (
    block.type.allowsMarkType(mark) &&
    !marks.some((held) => held.type !== mark && held.type.excludes(mark))
  );
}

/** How one style is read off a run of text. */
export interface StyleReading<T> {
  /** The style's mark type, which says where a press of it would land. */
  readonly mark: MarkType;
  /**
   * What the style reads as on one run.
   * @param marks - The marks on that run.
   * @returns Its value there.
   */
  valueOf: (marks: readonly Mark[]) => T;
  /** What it reads as on a run it is not on at all. */
  readonly absent: T;
}

/**
 * Builds a reading, where the schema declares the style.
 * @param state - The editor state, for its schema.
 * @param name - The mark's name.
 * @param valueOf - What the style reads as on one run.
 * @param absent - What it reads as where it is not on the run.
 * @returns The reading, or nothing where this build has no such mark.
 */
export function styleReading<T>(
  state: EditorState,
  name: string,
  valueOf: (marks: readonly Mark[]) => T,
  absent: T,
): StyleReading<T> | undefined {
  const mark = state.schema.marks[name];
  return mark === undefined ? undefined : { mark, valueOf, absent };
}

/**
 * Whether the selected part of a run counts towards what the control says.
 *
 * A run the style could never land on is left out: counting a code block's
 * text would leave the colour panel unable to confirm the hue it just applied.
 * Whitespace carrying nothing is left out too — that is the space a drag
 * picked up, which the press trims away and the reader was not asking about.
 * Whitespace carrying the style stays in: the reader can see a tinted space.
 *
 * Judged on the selected part rather than the whole run, since a trailing
 * space usually belongs to the run holding the next word.
 * @param reading - The style being read.
 * @param block - The block the run sits in.
 * @param marks - The marks on the run.
 * @param selected - The part of the run the selection covers.
 * @returns Whether its value counts.
 */
function counts<T>(
  reading: StyleReading<T>,
  block: PMNode,
  marks: readonly Mark[],
  selected: string,
): boolean {
  if (!landsOn(block, marks, reading.mark)) {
    return false;
  }
  return selected.trim() !== '' || reading.valueOf(marks) !== reading.absent;
}

/**
 * What a style reads as across the whole selection.
 * @param state - The editor state.
 * @param reading - The style to read.
 * @returns The one value every run that counts carries, or nothing where they
 *   disagree or none counted.
 */
export function readAcrossSelection<T>(
  state: EditorState,
  reading: StyleReading<T>,
): T | undefined {
  const { empty, $from, from, to } = state.selection;
  if (empty) {
    // A caret carries the marks it would type with, which is where a style
    // pressed with no selection goes.
    const held = state.storedMarks ?? $from.marks();
    return landsOn($from.parent, held, reading.mark)
      ? reading.valueOf(held)
      : undefined;
  }
  const seen = new Set<T>();
  state.doc.nodesBetween(from, to, (node: PMNode, pos, parent) => {
    if (!node.isText) {
      return true;
    }
    const selected = (node.text ?? '').slice(
      Math.max(from - pos, 0),
      Math.min(to - pos, node.nodeSize),
    );
    if (parent !== null && counts(reading, parent, node.marks, selected)) {
      seen.add(reading.valueOf(node.marks));
    }
    return false;
  });
  return seen.size === 1 ? [...seen][0] : undefined;
}

/**
 * Whether a press of this style would reach anything.
 *
 * Judged on {@link trimmedRange}, since that is where a press lands. One
 * reachable run is enough: a selection running from prose into a code block
 * still styles the prose.
 * @param state - The editor state.
 * @param reading - The style to press.
 * @returns Whether the control can act.
 */
export function pressReaches<T>(
  state: EditorState,
  reading: StyleReading<T>,
): boolean {
  const { empty, $from } = state.selection;
  if (empty) {
    const held = state.storedMarks ?? $from.marks();
    return landsOn($from.parent, held, reading.mark);
  }
  const { from, to } = trimmedRange(state.doc, state.selection);
  let reached = false;
  state.doc.nodesBetween(from, to, (node: PMNode, _pos, parent) => {
    if (!node.isText) {
      return true;
    }
    reached ||= parent !== null && landsOn(parent, node.marks, reading.mark);
    return false;
  });
  return reached;
}
