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
import type { EditorState, Transaction } from '@tiptap/pm/state';

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
 * Walks the text the selection covers that the style could land on.
 *
 * TEXT, and nothing else. A style is a thing a reader sees, and the other two
 * inline nodes this schema holds — `hardBreak` and `unsupportedInline` — show
 * none of it: a break is a line wrap, bold or coloured or not. Yjs agrees, and
 * more strongly: `y-prosemirror` maps a non-text inline node by its attributes
 * alone (`createTypeFromElementNode`, sync-plugin.js), so a mark put on one
 * would live in the pressing client's document and nowhere else.
 *
 * The write walks the same runs (`styleTheRuns`), which is what keeps the two
 * documents saying the same thing — and with them every reading of the local
 * one, tiptap's `isMarkActive` included.
 *
 * A caret covers one thing — the marks it would type with — so it is visited
 * here too, and the readings below hold no branch of their own for it.
 * @param state - The editor state.
 * @param mark - The style's mark type.
 * @param visit - Called per run with the marks it carries and, for a selection
 *   rather than a caret, the stretch of it the selection covers; return false
 *   to stop the walk.
 * @returns Whether anything was reached at all.
 */
function eachReachable(
  state: EditorState,
  mark: MarkType,
  visit: (marks: readonly Mark[], over?: { from: number; to: number }) => boolean,
): boolean {
  const { selection } = state;
  if (selection.empty) {
    const held = state.storedMarks ?? selection.$from.marks();
    if (!landsOn(selection.$from.parent, held, mark)) {
      return false;
    }
    visit(held);
    return true;
  }
  const { from, to } = selection;
  let reached = false;
  let going = true;
  state.doc.nodesBetween(from, to, (node: PMNode, pos, parent) => {
    if (!going || !node.isText) {
      return going;
    }
    if (!landsOn(parent!, node.marks, mark)) {
      return false;
    }
    reached = true;
    going = visit(node.marks, {
      from: Math.max(pos, from),
      to: Math.min(pos + node.nodeSize, to),
    });
    return false;
  });
  return reached;
}

/**
 * A transaction that puts a style on, or takes it off, every run the readings
 * above walk — the same walk, so the two can never cover different ground.
 *
 * `addMark` covers every inline node the selection holds, and the rule here is
 * that a node showing no style joins neither the reading nor the write. Letting
 * it cover a `hardBreak` was measurable twice over: the mark lived in the
 * pressing client's document and nowhere else, since Yjs drops it, and tiptap's
 * `isMarkActive` — which the `Mod-b` / `Mod-i` shortcuts branch on — counts any
 * inline node carrying marks, so the shortcut and the bar button answered
 * opposite on one selection.
 * @param state - The editor state.
 * @param mark - The style's mark type.
 * @param put - The mark to put on the runs, or nothing to take it off them.
 * @param into - A transaction to add the steps to, for a press that covers
 *   more than one style. Marking a range changes no position, so the steps of
 *   several styles compose without mapping.
 * @returns The transaction, or nothing at a caret, whose whole effect is the
 *   mark it would type with and which therefore has no range to cover.
 */
export function styleTheRuns(
  state: EditorState,
  mark: MarkType,
  put: Mark | undefined,
  into?: Transaction,
): Transaction | undefined {
  if (state.selection.empty) {
    return undefined;
  }
  const tr = into ?? state.tr;
  eachReachable(state, mark, (_marks, over) => {
    if (put === undefined) {
      tr.removeMark(over!.from, over!.to, mark);
    } else {
      tr.addMark(over!.from, over!.to, put);
    }
    return true;
  });
  return tr;
}

/**
 * Whether every run the selection covers carries this boolean style.
 *
 * The direction a press goes, as well as the state a button draws —
 * `document-tools.ts` branches on this same call, so the two can never differ.
 * tiptap's own `isMarkActive` answers a near-identical question and would save
 * the walk. It counts any inline node carrying marks, so the two agree exactly
 * as long as marks stay on text; `styleTheRuns` is what holds that, and the
 * `Mod-b` / `Mod-i` shortcuts read `isMarkActive` directly.
 * @param state - The editor state.
 * @param mark - The style's mark type.
 * @returns Whether it is on, which a selection reaching no text is not.
 */
export function everyRunCarries(state: EditorState, mark: MarkType): boolean {
  let all = true;
  const reached = eachReachable(state, mark, (marks) => {
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
 * @returns Its value there, or nothing where the selection covers no text this
 *   style could land on — which leaves every cell of that row unmarked.
 */
export function firstRunValue<T>(
  state: EditorState,
  mark: MarkType,
  valueOf: (marks: readonly Mark[]) => T,
): T | undefined {
  let answer: T | undefined;
  eachReachable(state, mark, (marks) => {
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
  return eachReachable(state, mark, () => false);
}
