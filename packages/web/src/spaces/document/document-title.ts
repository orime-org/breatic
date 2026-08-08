// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The document's title block.
 *
 * Every document Space opens with one, it is always the first block, and
 * nothing a user can do removes it. That is not a convenience — it is what
 * keeps the shared fragment inhabited. `@breatic/shared`'s `document-body`
 * carries the full reasoning; the short version is that a Yjs fragment can be
 * empty while ProseMirror's document model cannot, and when the two disagree
 * the editor writes a repair that counts as a user edit and destroys the redo
 * the user was entitled to. A first block nobody can issue a delete for closes
 * that gap by construction, so no merge of concurrent edits can produce one.
 *
 * Three properties do the work, and each is load-bearing:
 *
 * `group` is absent. The document's content rule is `title block*`, and the
 * body half of that only accepts nodes in the `block` group — so a title
 * cannot be created anywhere in the body, and the one at the front cannot be
 * replaced by anything else. Put it in the `block` group and both guarantees
 * evaporate at once.
 *
 * `marks: ''` refuses every mark the body accepts. Bold on the title is not
 * "allowed but discouraged", it does not apply.
 *
 * `isolating` keeps operations that span the boundary from reaching in and
 * dissolving the node — a whole-document range delete clears the body and
 * leaves the title standing.
 *
 * The content is `text*` rather than `inline*`: the title holds text, not
 * inline atoms. A reference chip or an inline image in a title has no meaning
 * and would need its own answers for serialisation and for what happens when
 * it is dragged out.
 */

import type { Editor } from '@tiptap/core';
import { Node } from '@tiptap/core';
import type { Command, EditorState, Transaction } from '@tiptap/pm/state';
import { TextSelection } from '@tiptap/pm/state';
import { DOCUMENT_TITLE_NODE } from '@breatic/shared';

/**
 * Class name the title renders with.
 *
 * Exported because the stylesheet and the placeholder both key off it, and a
 * literal repeated in three files is three places to drift.
 */
export const DOCUMENT_TITLE_CLASS = 'doc-title';

/**
 * The title node.
 *
 * Its name comes from `@breatic/shared` because the backend writes this node
 * into Yjs directly, without going through ProseMirror. A mismatch between the
 * two would be silent: the editor deletes what it cannot resolve and
 * broadcasts that deletion as its own edit.
 */
export const DocumentTitle = Node.create({
  name: DOCUMENT_TITLE_NODE,
  content: 'text*',
  marks: '',
  defining: true,
  isolating: true,
  parseHTML: () => [{ tag: `h1.${DOCUMENT_TITLE_CLASS}` }],
  renderHTML: () => ['h1', { class: DOCUMENT_TITLE_CLASS }, 0],

  /**
   * The keys that cross the line between the title and the body.
   *
   * They live together because they are one decision rather than three: Enter
   * cuts the title at the caret and drops the tail into the body, and both
   * Backspace and Delete are that same cut run backwards. Defining any of them
   * without the others leaves a boundary a user can fall through — press Enter
   * by mistake and there is no way back.
   *
   * Vertical arrows are not here. Moving the caret up and down in a
   * contenteditable is the browser's own behaviour, not something key handling
   * sees, and the title is an ordinary editable block as far as the browser is
   * concerned — so nothing needs doing, and nothing here could do it.
   * @returns The key bindings, by key name.
   */
  addKeyboardShortcuts() {
    return {
      Enter: asShortcut(this.editor, splitTitleIntoBody),
      Backspace: asShortcut(this.editor, mergeBodyStartIntoTitle),
      Delete: asShortcut(this.editor, pullBodyIntoTitleEnd),
    };
  },
});

/**
 * Wrap a ProseMirror command so it can be bound to a key.
 *
 * Deliberately NOT routed through `editor.commands.command(...)`: that wrapper
 * hands the callback a props object rather than the `(state, dispatch)` pair a
 * ProseMirror command expects, and it dispatches a transaction of its own
 * afterwards — one taken from the state BEFORE the callback ran, so a command
 * that builds and dispatches its own has its work reverted.
 * @param editor - The editor the key was pressed in.
 * @param command - The command to run.
 * @returns A key handler reporting whether it handled the key.
 */
function asShortcut(editor: Editor, command: Command): () => boolean {
  return () => command(editor.state, editor.view.dispatch);
}

/**
 * Move the title's first block worth of text into the body, at the caret.
 *
 * Declines unless the caret is a plain cursor inside the title, so Enter keeps
 * its ordinary meaning everywhere else.
 * @param state - Current editor state.
 * @param dispatch - Applies the transaction; absent when the caller is only asking whether this would apply.
 * @returns True when this handled the key.
 */
const splitTitleIntoBody: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type.name !== DOCUMENT_TITLE_NODE) return false;

  const title = state.doc.child(0);
  const paragraph = state.schema.nodes['paragraph'];
  if (!paragraph) return false;

  const tail = title.textBetween($from.parentOffset, title.content.size);
  if (!dispatch) return true;

  const tr = state.tr;
  // Cut the tail out of the title first; the title sits at the front of the
  // document, so this does not move the position the new block goes at once
  // the mapping is applied.
  if (tail) tr.delete($from.pos, 1 + title.content.size);
  const insertAt = tr.mapping.map(title.nodeSize);
  tr.insert(insertAt, paragraph.create(null, tail ? state.schema.text(tail) : null));
  tr.setSelection(TextSelection.create(tr.doc, insertAt + 1));
  dispatch(tr.scrollIntoView());
  return true;
};

/**
 * Fold the body's first block back into the end of the title.
 *
 * The text arrives as plain text because the title holds no marks — a bold
 * paragraph merged into the title comes back unbold rather than carrying a
 * mark the schema would drop on the next parse.
 * @param state - Current editor state.
 * @param dispatch - Applies the transaction.
 * @returns True when this handled the key.
 */
function mergeFirstBodyBlock(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
): boolean {
  if (state.doc.childCount < 2) return false;
  const title = state.doc.child(0);
  const first = state.doc.child(1);
  if (!dispatch) return true;

  const titleContentEnd = 1 + title.content.size;
  const tr = state.tr;
  tr.delete(title.nodeSize, title.nodeSize + first.nodeSize);
  const text = first.textContent;
  if (text) tr.insert(titleContentEnd, state.schema.text(text));
  tr.setSelection(TextSelection.create(tr.doc, titleContentEnd));
  dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Backspace at the very start of the body's first block.
 *
 * This is Enter run backwards, and it is the only way back from an Enter
 * pressed by mistake.
 * @param state - Current editor state.
 * @param dispatch - Applies the transaction.
 * @returns True when this handled the key.
 */
const mergeBodyStartIntoTitle: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0 || $from.index(0) !== 1) return false;
  return mergeFirstBodyBlock(state, dispatch);
};

/**
 * Delete at the very end of the title.
 *
 * Same join as the Backspace above, reached from the other side.
 * @param state - Current editor state.
 * @param dispatch - Applies the transaction.
 * @returns True when this handled the key.
 */
const pullBodyIntoTitleEnd: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type.name !== DOCUMENT_TITLE_NODE) return false;
  if ($from.parentOffset !== $from.parent.content.size) return false;
  return mergeFirstBodyBlock(state, dispatch);
};
