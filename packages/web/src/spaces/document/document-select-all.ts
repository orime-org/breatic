// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * `Mod-a` selects everything on the caret's side, with the title and the body
 * sealed off from each other.
 *
 * One press, one answer (decided 2026-08-15): in the body it takes the whole
 * body, in the title it takes the title, and with the caret in neither it takes
 * the whole body. Pressing again changes nothing. **From the body you can never
 * reach the title, and from the title you can never reach the body.**
 *
 * There is no second tier. An earlier version took the caret's own block first
 * and the whole body on a second press; that is a feature of some editors and
 * not of this key. ProseMirror's own basic example is one tier, measured: a
 * press selects 515 characters and a second press selects the same 515.
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
import { Selection, TextSelection } from '@tiptap/pm/state';
import { DOCUMENT_TITLE_NODE } from '@breatic/shared';

/** A pair of document positions, resolved and ready to select between. */
interface Range {
  from: number;
  to: number;
}

/**
 * Where the body starts — everything the title occupies comes before it.
 * @param state - Editor state to read.
 * @returns The position just past the title node.
 */
function bodyStart(state: EditorState): number {
  return state.doc.child(0).nodeSize;
}

/**
 * The selection covering the whole body, or null when the body has no blocks.
 *
 * `TextSelection.between` is handed the body's two boundary positions and moves
 * each end to the nearest text position, which is what makes this an ordinary
 * text selection: both ends sit in inline content. That matters beyond
 * tidiness. `createParagraphNear`, `deleteSelection` and the rest of
 * `prosemirror-commands` decide whether they apply by asking
 * `$from.parent.inlineContent`, so a selection whose ends sit on block
 * boundaries makes Enter, a typed character and Delete behave differently from
 * every other editor. Measured with a selection type of our own whose ends were
 * the body's boundaries: pressing Enter over the whole body deleted nothing and
 * appended an empty paragraph instead.
 *
 * Which end moves which way is not left to chance. `between` derives its bias
 * from the two positions (`prosemirror-state` `TextSelection.between`): the
 * anchor comes before the head here, so the head searches backwards from the
 * body's end and the anchor forwards from its start — each toward the body,
 * neither toward the title.
 *
 * **There is no guard for "the body has blocks but none of them holds text".**
 * The only textless block this schema still has is `unsupportedBlock`, which is
 * an atom, renders as an empty `div` with no styling, and cannot be reached: a
 * document containing one is intercepted and the editor is never built
 * (`use-document-schema-intercept`). The divider used to be the other one, and
 * it is gone.
 * @param state - Editor state to read.
 * @returns The body's selection, or null when there is nothing to select.
 */
function bodySelection(state: EditorState): Selection | null {
  const start = bodyStart(state);
  const end = state.doc.content.size;
  if (start >= end) return null;
  return TextSelection.between(state.doc.resolve(start), state.doc.resolve(end));
}

/**
 * The range of the block the caret is in.
 *
 * Only the title reaches this now, and asking `$from` where its own block
 * starts and ends needs no knowledge of which block that is. An earlier version
 * had a separate `titleRange` that computed `1 .. 1 + child(0).content.size` —
 * the same two numbers by a different route, carrying two assumptions of its
 * own (that the title starts at 1, and that it is the first child).
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
 * One question answers every selection shape: is `$from` inside a block that
 * holds text? A whole-body selection and an `AllSelection` both start at a
 * position between top-level blocks, whose parent is the document node, and a
 * document is not a textblock — so both come back "neither" and get answered
 * with the whole body, which is also the right answer for them.
 *
 * Asked of `$from`, not of the selection's shape. A selection that is not
 * collapsed still has a `$from`, and it is what the rule means by "where the
 * caret is": a double-clicked word in the title is a press made in the title,
 * and answering otherwise is how a press there ends up selecting the body.
 * @param state - Editor state to read.
 * @returns Which side the press acts on.
 */
function sideOfCaret(state: EditorState): 'title' | 'body' | 'neither' {
  const { $from } = state.selection;
  if ($from.parent.type.name === DOCUMENT_TITLE_NODE) return 'title';
  // The question is whether the position is INSIDE a block that holds text,
  // not how deep it sits. `depth === 0` only catches the top level, so a node
  // selection on a block inside a list item came back as "in the body" and got
  // answered with the block around it — measured, that produced an empty
  // selection in a paragraph the user was never in.
  if (!$from.parent.isTextblock) return 'neither';
  return 'body';
}

/**
 * The selection the press should produce.
 *
 * "Neither" maps to the body, and that is not the same case as an empty body.
 * A whole block being selected is the common way to get there: `Mod`-clicking a
 * paragraph makes a `NodeSelection` (`prosemirror-view` builds one when the
 * platform's select-node modifier is held, and `document-click-to-write` passes
 * modified clicks straight through), and a selection over a whole block sits
 * OUTSIDE that block, at document level, so `$from.parent` is the document.
 * Answering that with the title would mean: click a paragraph, press this key,
 * type one character, and the document's name is gone — the one outcome this
 * whole extension exists to prevent.
 * @param state - Editor state to read.
 * @returns The selection to apply, or null when there is nothing to select.
 */
function nextSelection(state: EditorState): Selection | null {
  if (sideOfCaret(state) !== 'title') return bodySelection(state);
  const title = currentBlockRange(state);
  return TextSelection.between(
    state.doc.resolve(title.from),
    state.doc.resolve(title.to),
  );
}

/**
 * Select everything on the caret's side of the document.
 *
 * **Always reports the key as handled**, including when it selects what was
 * already selected. Declining would hand `Mod-a` back to `@tiptap/core`'s
 * `Keymap`, whose binding is `selectAll` — the exact behaviour this exists to
 * replace. "Nothing changes" means giving back the same range, not leaving the
 * key to someone else.
 *
 * There is one case where it reports handled without selecting anything: a
 * document whose body has no blocks at all, with the caret in neither side.
 * Nothing to select is not the same as nothing to do — the key still belongs
 * to us, and leaving the selection untouched is the answer. (Whoever took the
 * key there would end up selecting the title, which is all the document holds,
 * so this particular case is about who owns the key rather than about keeping
 * the title out of a selection.)
 * @param state - Editor state to read.
 * @param dispatch - Applies the transaction.
 * @returns True, always.
 */
function selectThisSide(
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
 *
 * This answers for an editable editor. A read-only one never gets here at all,
 * and moving the binding does not change that: measured in a browser, a
 * read-only editor's DOM carries `contenteditable="false"` and no `tabindex`,
 * so clicking the text leaves focus on `body` and the key press never reaches
 * the editor's DOM node in the first place. What a viewer should get from this
 * key belongs with the rest of read-only behaviour, which is a separate piece
 * of work.
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
      'Mod-a': () => selectThisSide(this.editor.state, this.editor.view.dispatch),
    };
  },
});
