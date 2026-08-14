// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * `Mod-a`, one tier at a time, with the title and the body sealed off from
 * each other.
 *
 * The rule (decided 2026-08-11): in the body, one press takes the block the
 * caret is in and a second takes the whole body; in the title, a press takes
 * the title and a second changes nothing; with the caret in neither, a press
 * takes the whole body. **From the body you can never reach the title, and
 * from the title you can never reach the body.**
 *
 * ## Why this is ours to write
 *
 * `@tiptap/core` ships its own `Keymap` extension binding `Mod-a` to
 * `selectAll()`, and that command is the defect: measured, it produces an
 * `AllSelection` starting at 0, which is inside the title. The title is the
 * document's name — the AI slice replaces what is selected, and a rewrite
 * landing on the name is destructive in a way no undo makes acceptable to
 * ship.
 *
 * The reason this cannot be left to the editor is structural: our title is
 * the first block of the same ProseMirror document as the body (content rule
 * `title block*`), so "everything" genuinely includes it. Editors whose title
 * is a separate field get this for free.
 *
 * ## Why it does not live in `document-title`
 *
 * That file defines the title node, and each of its keys asks "is the caret
 * in the title" and declines when it is not. This one has to answer for both
 * sides in the same press, so putting it there would give the title node the
 * body's selection logic.
 */

import { Extension } from '@tiptap/core';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { AllSelection, Selection, TextSelection } from '@tiptap/pm/state';
import { DOCUMENT_TITLE_NODE } from '@breatic/shared';

/** A pair of document positions, resolved and ready to select between. */
interface Range {
  from: number;
  to: number;
}

/**
 * Whether two ranges are the same one.
 * @param a - One range.
 * @param b - The other.
 * @returns True when both ends match.
 */
function sameRange(a: Range, b: Range): boolean {
  return a.from === b.from && a.to === b.to;
}

/**
 * The title's text range.
 *
 * Position 1 is where the first block's content starts, and the title is
 * always that first block — the content rule admits nothing else there.
 * @param state - Editor state to read.
 * @returns The range covering the title's text.
 */
function titleRange(state: EditorState): Range {
  return { from: 1, to: 1 + state.doc.child(0).content.size };
}

/**
 * The selection covering the whole body, or null when there is nothing there.
 *
 * **This returns a SELECTION, not a range, and that is the whole point.** An
 * earlier version computed a range here and built the selection somewhere
 * else, which meant two different rulers: the range came from
 * `Selection.near`, and `TextSelection.between` then moved an endpoint that
 * did not sit in inline content. The tier check compared the live selection
 * against the range, the two never matched, and a third press SHRANK back to
 * the caret's block. Measured in the browser on a document whose last block
 * is an `unsupportedBlock`: the range said `9..3805`, the selection actually
 * dispatched was `9..3803`, and pressing again bounced between the first
 * block and the whole body. Producing the answer once, here, is what keeps
 * the comparison honest.
 *
 * Both ends go through `Selection.near` rather than arithmetic on the title's
 * size, because the body's first block may be a container: with a list first,
 * the first text position is two levels in (`bulletList > listItem >
 * paragraph`), and measured, `near` lands on it while `titleSize + 1` does
 * not.
 *
 * What `near` cannot be trusted with is the answer when there is nothing to
 * find. Its contract is to search the other way if the first direction comes
 * up empty, so with an empty body it walks back INTO the title — measured, it
 * returns a cursor at position 2, inside the title node. Same for the
 * selection `between` builds: with a body holding only a divider, neither end
 * is inline content and it lands at position 6, inside a 7-wide title. Both
 * are caught by the same check — anything that starts before the body starts
 * is not an answer about the body.
 * @param state - Editor state to read.
 * @returns The body's selection, or null when there is nothing to select.
 */
function bodySelection(state: EditorState): Selection | null {
  const bodyStart = state.doc.child(0).nodeSize;
  if (state.doc.content.size <= bodyStart) return null;
  const head = Selection.near(state.doc.resolve(bodyStart), 1);
  const tail = Selection.near(state.doc.resolve(state.doc.content.size), -1);
  if (head.from < bodyStart || tail.to < head.from) return null;
  const text = TextSelection.between(
    state.doc.resolve(head.from),
    state.doc.resolve(tail.to),
  );
  // `between` reaches outward for inline content and can land in the title;
  // when it does, the node selection `near` found is the right answer for a
  // body made of atoms.
  return text.from >= bodyStart ? text : head;
}

/**
 * The range of the block the caret is in.
 * @param state - Editor state to read.
 * @returns That block's content range.
 */
function currentBlockRange(state: EditorState): Range {
  const { $from } = state.selection;
  return { from: $from.start(), to: $from.end() };
}

/**
 * Which side of the document the caret is on.
 *
 * Asked of `$from`, not of the selection's shape. A selection that is not
 * collapsed still has a `$from`, and it is what the rule means by "where the
 * caret is": a double-clicked word in the title is a press made in the title,
 * and answering otherwise is how a press there ends up selecting the body.
 * @param state - Editor state to read.
 * @returns Which side the next press acts on.
 */
function sideOfCaret(state: EditorState): 'title' | 'body' | 'neither' {
  if (state.selection instanceof AllSelection) return 'neither';
  const { $from } = state.selection;
  if ($from.parent.type.name === DOCUMENT_TITLE_NODE) return 'title';
  // `depth === 0` puts $from between blocks rather than inside one: a gap
  // cursor, or a node selection on a block-level atom.
  if ($from.depth === 0) return 'neither';
  return 'body';
}

/**
 * The selection the next press should produce.
 *
 * Every branch returns the selection itself rather than a range someone else
 * turns into one — see {@link bodySelection} for what the two-ruler version
 * cost.
 * @param state - Editor state to read.
 * @returns The selection to apply, or null when there is nothing to select.
 */
function nextSelection(state: EditorState): Selection | null {
  const side = sideOfCaret(state);
  if (side === 'title') return selectionOverRange(state, titleRange(state));
  if (side === 'neither') return bodySelection(state);

  const block = selectionOverRange(state, currentBlockRange(state));
  const body = bodySelection(state);
  const current: Range = { from: state.selection.from, to: state.selection.to };
  // The top tier holds: once the whole body is selected there is nowhere
  // further to go, and answering with the caret's block would SHRINK the
  // selection — which is what a third press did before this branch existed.
  if (body && sameRange(current, { from: body.from, to: body.to })) return body;
  // Already exactly this block: the press means "widen". Anything else —
  // a caret, part of the block, a stretch across blocks — collapses to the
  // block the caret is in, which is the first tier.
  return block && sameRange(current, { from: block.from, to: block.to })
    ? body
    : block;
}

/**
 * A text selection over a range that is known to sit in inline content.
 *
 * Used for the title and for the caret's own block — both are textblocks by
 * construction, so `between` has somewhere to land and cannot wander.
 * @param state - Editor state to read.
 * @param range - The range to cover.
 * @returns The selection over it.
 */
function selectionOverRange(state: EditorState, range: Range): Selection {
  return TextSelection.between(
    state.doc.resolve(range.from),
    state.doc.resolve(range.to),
  );
}

/**
 * Select one tier out from where the caret is.
 *
 * **Always reports the key as handled**, including when it selects what was
 * already selected. Declining would hand `Mod-a` back to `@tiptap/core`'s
 * `Keymap`, whose binding is `selectAll` — the exact behaviour this exists to
 * replace. "Does not widen any further" means giving back the same range, not
 * leaving the key to someone else.
 * @param state - Editor state to read.
 * @param dispatch - Applies the transaction.
 * @returns True, always.
 */
export function selectOneTierOut(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
): boolean {
  const selection = nextSelection(state);
  if (!selection || !dispatch) return true;
  dispatch(state.tr.setSelection(selection));
  return true;
}


/**
 * The `Mod-a` binding.
 *
 * `priority` is above `@tiptap/core`'s `Keymap` extension so this is asked
 * first; `DocumentTitle` claims its own keys at the same height for the same
 * reason.
 *
 * `Mod-` resolves once, when `prosemirror-keymap` is first evaluated, to
 * `Cmd` on macOS and `Ctrl` everywhere else — it is not both at once. Binding
 * `Ctrl-a` as well would be wrong rather than thorough: on macOS `@tiptap/core`
 * already binds it to `selectTextblockStart`.
 */
export const DocumentSelectAll = Extension.create({
  name: 'documentSelectAll',
  priority: 1000,

  /**
   * Bind the key.
   * @returns The key bindings, by key name.
   */
  addKeyboardShortcuts() {
    return {
      'Mod-a': () => selectOneTierOut(this.editor.state, this.editor.view.dispatch),
    };
  },
});
