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
 * - A press that REMOVES covers the whole highlight, and needs no room for a
 *   new mark, so it can act where an add lands nothing.
 * - What the control SAYS speaks for the whole highlight, because that is what
 *   the reader is looking at.
 *
 * {@link readStyle} answers all three off one walk, so nothing that judges a
 * control and nothing that runs a press can disagree about what is under the
 * selection. Judged on the add range alone, an unlit Bold took bold off a
 * word, a lit Bold was drawn unavailable at the same instant, and the colour
 * panel drew "no fill" as the one in force over a highlight holding a tinted
 * space — then cleared it.
 *
 * The five marks and the colour rows differ in one thing only, which
 * {@link StyleReading.skipsBlanks} carries: whether a blank run carrying
 * nothing joins the answer.
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
  /**
   * Whether a run of blank text carrying nothing is left out of the answer.
   *
   * The colour panel skips it: a reader dragging over a red word picks up the
   * space after it, and the panel has to go on saying red. The five marks
   * count it, because the keyboard reaches those same five commands through
   * their own shortcuts (`Mod-b` and friends, `SelectionBubbleBar`'s note) and
   * BlockNote's reading behind those counts every run — a button that skipped
   * the space would say ON where the keyboard says OFF, and the two would then
   * do opposite things to one selection.
   */
  readonly skipsBlanks: boolean;
}

/**
 * Builds a reading, where the schema declares the style.
 * @param state - The editor state, for its schema.
 * @param name - The mark's name.
 * @param valueOf - What the style reads as on one run.
 * @param absent - What it reads as where it is not on the run.
 * @param skipsBlanks - See {@link StyleReading.skipsBlanks}.
 * @returns The reading, or nothing where this build has no such mark.
 */
export function styleReading<T>(
  state: EditorState,
  name: string,
  valueOf: (marks: readonly Mark[]) => T,
  absent: T,
  skipsBlanks: boolean,
): StyleReading<T> | undefined {
  const mark = state.schema.marks[name];
  return mark === undefined
    ? undefined
    : { mark, valueOf, absent, skipsBlanks };
}

/**
 * Whether a reachable run's value joins the vote.
 *
 * Whitespace carrying nothing does not — that is the space a drag picked up,
 * which the press trims away and the reader was not asking about. Whitespace
 * carrying the style does: the reader can see a tinted space.
 *
 * Judged on the selected part rather than the whole run, since a trailing
 * space usually belongs to the run holding the next word.
 * @param reading - The style being read.
 * @param marks - The marks on the run.
 * @param selected - The part of the run the selection covers.
 * @returns Whether its value counts.
 */
function counts<T>(
  reading: StyleReading<T>,
  marks: readonly Mark[],
  selected: string,
): boolean {
  if (!reading.skipsBlanks) {
    return true;
  }
  return selected.trim() !== '' || reading.valueOf(marks) !== reading.absent;
}

/** Everything one style answers over one selection, off a single walk. */
export interface StyleAcross<T> {
  /**
   * Whether a press that ADDS would land on anything, judged on
   * {@link trimmedRange} since that is where such a press goes. One reachable
   * run is enough: a selection running from prose into a code block still
   * styles the prose.
   */
  readonly addReaches: boolean;
  /**
   * Whether any run under the selection carries the style at all, which is
   * what a press that REMOVES has to work on. That press covers the whole
   * highlight and needs no room for a new mark, so it can act where an add
   * lands nothing.
   */
  readonly anyCarries: boolean;
  /**
   * The one value every counting run carries: the style's `absent` where they
   * all carry none, or nothing where they disagree or none was reachable.
   */
  readonly value: T | undefined;
}

/**
 * Reads one style across one selection.
 *
 * The walk covers the whole highlight, because that is what the reader is
 * looking at, and marks each run with whether it also falls in the range an
 * add would land in. Three answers come off it, so nothing that judges a
 * control and nothing that runs a press can disagree about what is under the
 * selection.
 * @param state - The editor state.
 * @param reading - The style to read.
 * @returns What that style answers here.
 */
export function readStyle<T>(
  state: EditorState,
  reading: StyleReading<T>,
): StyleAcross<T> {
  const { empty, $from, from, to } = state.selection;
  if (empty) {
    // A caret carries the marks it would type with, which is where a style
    // pressed with no selection goes.
    const held = state.storedMarks ?? $from.marks();
    const reaches = landsOn($from.parent, held, reading.mark);
    const value = reaches ? reading.valueOf(held) : undefined;
    return {
      addReaches: reaches,
      anyCarries: value !== undefined && value !== reading.absent,
      value,
    };
  }
  const press = trimmedRange(state.doc, state.selection);
  const seen = new Set<T>();
  let reached = false;
  let addReaches = false;
  let anyCarries = false;
  state.doc.nodesBetween(from, to, (node: PMNode, pos, parent) => {
    if (!node.isText) {
      return true;
    }
    if (parent === null || !landsOn(parent, node.marks, reading.mark)) {
      return false;
    }
    reached = true;
    addReaches ||= pos < press.to && pos + node.nodeSize > press.from;
    const value = reading.valueOf(node.marks);
    anyCarries ||= value !== reading.absent;
    const selected = (node.text ?? '').slice(
      Math.max(from - pos, 0),
      Math.min(to - pos, node.nodeSize),
    );
    if (counts(reading, node.marks, selected)) {
      seen.add(value);
    }
    return false;
  });
  if (!reached) {
    return { addReaches: false, anyCarries: false, value: undefined };
  }
  // Every run was blank and carried nothing. Those runs make no disagreement,
  // and what they agree on is that the style is not here — which is an answer
  // the control draws, not an absence of one: the colour panel marks its first
  // cell on it.
  const value =
    seen.size === 0
      ? reading.absent
      : seen.size === 1
        ? [...seen][0]
        : undefined;
  return { addReaches, anyCarries, value };
}
