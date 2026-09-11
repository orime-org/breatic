// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the selection says about a style, for the controls that draw it.
 *
 * The selection IS the range a command acts on — not a character more, not a
 * character less (user 2026-09-11, a rule for the whole document space). A
 * space is content: it carries a colour, a fill and a weight, it is only
 * invisible. So it joins the range a press covers and it joins the reading
 * here, and nothing trims the selection before acting on it.
 *
 * The two readings differ because the styles differ, and they differ the way
 * the W3C execCommand spec splits them:
 *
 * - A BOOLEAN style (the five marks) is on when every run carries it —
 *   "all of them have an effective command value equal to one of the given
 *   values". {@link everyRunCarries}.
 * - A VALUE style (the two colour rows) reads off "the effective command value
 *   of the first formattable node that is effectively contained in the active
 *   range". {@link firstRunValue}. CKEditor 5, Slate and TinyMCE all read the
 *   first run this way.
 */

import type { Mark, MarkType, Node as PMNode } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';

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

/**
 * The mark type a style is stored as, where this build declares one.
 * @param state - The editor state, for its schema.
 * @param name - The style's name, which is also the mark's.
 * @returns The type, or nothing where no such mark exists.
 */
export function markTypeOf(
  state: EditorState,
  name: string,
): MarkType | undefined {
  return state.schema.marks[name];
}

/**
 * Walks the runs of text the selection covers that the style could land on.
 * @param state - The editor state.
 * @param mark - The style's mark type.
 * @param visit - Called per run; return false to stop the walk.
 * @returns Whether any run was reached at all.
 */
function eachReachableRun(
  state: EditorState,
  mark: MarkType,
  visit: (marks: readonly Mark[]) => boolean,
): boolean {
  const { from, to } = state.selection;
  let reached = false;
  let going = true;
  state.doc.nodesBetween(from, to, (node: PMNode, _pos, parent) => {
    if (!going || !node.isText) {
      return going;
    }
    if (parent === null || !landsOn(parent, node.marks, mark)) {
      return false;
    }
    reached = true;
    going = visit(node.marks);
    return false;
  });
  return reached;
}

/**
 * Whether every run the selection covers carries this boolean style.
 *
 * The predicate BlockNote's `toggleStyles` decides its direction by, so the
 * button and the press can never disagree: it forwards to tiptap's
 * `toggleMark`, which reads `isMarkActive` (every character must carry it)
 * before branching to `setMark` or `unsetMark`.
 *
 * BlockNote's own `getActiveStyles()` reads `selection.$to.marks()` — the
 * marks at one point, the selection's end — which is a different question, and
 * upstream's toolbar is inconsistent with its own press because of it.
 * @param state - The editor state.
 * @param mark - The style's mark type.
 * @returns Whether it is on, which a selection reaching no run is not.
 */
export function everyRunCarries(state: EditorState, mark: MarkType): boolean {
  if (state.selection.empty) {
    const held = state.storedMarks ?? state.selection.$from.marks();
    return (
      landsOn(state.selection.$from.parent, held, mark) &&
      held.some((one) => one.type === mark)
    );
  }
  let all = true;
  const reached = eachReachableRun(state, mark, (marks) => {
    all = marks.some((one) => one.type === mark);
    return all;
  });
  return reached && all;
}

/**
 * What this value style reads as on the first run the selection covers.
 *
 * Reading the first run is the W3C execCommand definition for a value command
 * (`foreColor` and `backColor` among them), and how CKEditor 5, Slate and
 * TinyMCE each answer. It costs one short-circuited walk and asks nothing
 * about whitespace: a drag that overshoots a coloured word onto the space
 * after it opens on that word, so the panel goes on naming its hue.
 * @param state - The editor state.
 * @param mark - The style's mark type.
 * @param valueOf - What the style reads as on one run's marks.
 * @returns Its value there, or nothing where the selection reaches no run this
 *   style could land on — which leaves every cell of that row unmarked.
 */
export function firstRunValue<T>(
  state: EditorState,
  mark: MarkType,
  valueOf: (marks: readonly Mark[]) => T,
): T | undefined {
  if (state.selection.empty) {
    const held = state.storedMarks ?? state.selection.$from.marks();
    return landsOn(state.selection.$from.parent, held, mark)
      ? valueOf(held)
      : undefined;
  }
  let answer: T | undefined;
  eachReachableRun(state, mark, (marks) => {
    answer = valueOf(marks);
    return false;
  });
  return answer;
}

/**
 * Whether a style could land anywhere under the selection.
 *
 * R7 (`document-tool-button.tsx`) asks that no control look usable and do
 * nothing. One reachable run is enough: a selection running from prose into a
 * code block still styles the prose.
 * @param state - The editor state.
 * @param mark - The style's mark type.
 * @returns Whether a press would reach anything.
 */
export function reachesAnyRun(state: EditorState, mark: MarkType): boolean {
  if (state.selection.empty) {
    const held = state.storedMarks ?? state.selection.$from.marks();
    return landsOn(state.selection.$from.parent, held, mark);
  }
  return eachReachableRun(state, mark, () => false);
}
