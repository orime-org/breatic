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
 * Two properties do the work, and each is load-bearing:
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
 * **`isolating` is deliberately NOT set**, and this is worth stating because it
 * was, for three rounds of review. The claim was that it kept a boundary-
 * spanning operation from dissolving the node. Measured both ways, it does
 * nothing of the sort: select-all-and-delete, a whole-document range delete, a
 * delete across the boundary and a node selection on the title itself all leave
 * the title standing either way. The content rule above is what keeps it there.
 *
 * What `isolating` did do was make every one of ProseMirror's own boundary
 * handlers bail before reaching this node — `deleteBarrier`, `joinForward`,
 * `splitBlock`, the arrow-key handlers, all of them. Each gesture that hit the
 * boundary then had to be written out by hand, and the ones nobody had written
 * yet did nothing at all: Enter over a selection reaching into the body was
 * dead, and the left arrow at the title's start dropped the caret into a gap
 * cursor with nowhere to type. Both work by themselves without it.
 *
 * The content is `text*` rather than `inline*`: the title holds text, not
 * inline atoms. A reference chip or an inline image in a title has no meaning
 * and would need its own answers for serialisation and for what happens when
 * it is dragged out.
 */

import type { Editor } from '@tiptap/core';
import { Node } from '@tiptap/core';
import type { Command, EditorState, Transaction } from '@tiptap/pm/state';
import { Selection, TextSelection } from '@tiptap/pm/state';
import { liftTarget } from '@tiptap/pm/transform';
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
 * A selection wholly inside the title is replaced first, exactly as pressing
 * any key over a selection replaces it, and the split then happens where that
 * leaves the caret.
 *
 * Declines when the selection reaches out of the title: that is an ordinary
 * range, and the editor's own Enter deletes it — which joins the two blocks —
 * and splits at the caret. It really does answer, now that the title is not
 * isolating; while it was, that path bailed at the boundary and the key did
 * nothing at all.
 * @param state - Current editor state.
 * @param dispatch - Applies the transaction; absent when the caller is only asking whether this would apply.
 * @returns True when this handled the key.
 */
const splitTitleIntoBody: Command = (state, dispatch) => {
  const { $from, $to } = state.selection;
  if ($from.parent.type.name !== DOCUMENT_TITLE_NODE) return false;
  if ($to.parent.type.name !== DOCUMENT_TITLE_NODE) return false;

  const paragraph = state.schema.nodes['paragraph'];
  if (!paragraph) return false;
  if (!dispatch) return true;

  const tr = state.tr;
  // A no-op for a collapsed cursor, so both cases run the same path from here.
  tr.deleteSelection();

  // The title is the document's first child, so it occupies positions 0 to its
  // own size and the block after it starts exactly there. Read both back from
  // the transaction rather than the original state — the deletion above moved
  // them.
  const cut = tr.selection.$from.parentOffset;
  const title = tr.doc.child(0);
  const tail = title.textBetween(cut, title.content.size);
  if (tail) tr.delete(tr.selection.from, 1 + title.content.size);
  const insertAt = tr.doc.child(0).nodeSize;
  tr.insert(
    insertAt,
    paragraph.create(null, tail ? state.schema.text(tail) : null),
  );
  tr.setSelection(TextSelection.create(tr.doc, insertAt + 1));
  dispatch(tr.scrollIntoView());
  return true;
};

/**
 * Fold the body's first block back into the end of the title.
 *
 * Only a textblock — a paragraph, a heading, a code block. A container block
 * holds several textblocks of its own, and folding one in would delete every
 * one of them and run their text together; `liftFirstBodyTextblock` is what
 * answers for those.
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
  if (!first.isTextblock) return false;
  if (!dispatch) return true;

  const titleContentEnd = 1 + title.content.size;
  const tr = state.tr;
  tr.delete(title.nodeSize, title.nodeSize + first.nodeSize);
  // A soft line break has no text of its own, so plain `textContent` would run
  // the lines either side of it into one word. The title cannot hold the break
  // — its content is text and nothing else — so a space is what it becomes.
  const text = first.textBetween(0, first.content.size, undefined, ' ');
  if (text) tr.insert(titleContentEnd, state.schema.text(text));
  tr.setSelection(TextSelection.create(tr.doc, titleContentEnd));
  dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Lift the first textblock inside the body's first container block out of it.
 *
 * This is what the editor itself does at every other boundary in the body: with
 * the caret at the end of a paragraph followed by a list, Delete lifts the
 * first item out as a paragraph of its own and leaves the rest of the list
 * standing, and a second press then merges it. Measured in the browser on this
 * build.
 *
 * The title cannot inherit that behaviour, because it is `isolating` and
 * `prosemirror-commands`' `deleteBarrier` refuses to cross an isolating
 * boundary before it ever reaches its lift branch. So the three calls that
 * branch makes are made here instead — the same `Selection.findFrom`,
 * `blockRange` and `liftTarget`, which is why the result matches the body
 * rather than resembling it.
 * @param state - Current editor state.
 * @param dispatch - Applies the transaction.
 * @returns True when this handled the key.
 */
function liftFirstBodyTextblock(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
): boolean {
  if (state.doc.childCount < 2) return false;
  const boundary = state.doc.child(0).nodeSize;
  const container = state.doc.child(1);
  const inside = Selection.findFrom(state.doc.resolve(boundary), 1);
  // `findFrom` searches the whole document forward, not just the block the key
  // is aimed at, so a container with nothing selectable inside it would send it
  // into a LATER block and lift one the press never touched. No node type in
  // today's schema is like that — every container bottoms out in a textblock —
  // and this comparison is what keeps that from having to be re-derived each
  // time a type is added.
  if (!inside || inside.$from.pos >= boundary + container.nodeSize) return false;
  const range = inside.$from.blockRange(inside.$to);
  const target = range ? liftTarget(range) : null;
  if (!range || target === null) return false;
  if (!dispatch) return true;
  dispatch(state.tr.lift(range, target).scrollIntoView());
  return true;
}

/**
 * Remove a body-leading block that has no interior at all — a divider.
 *
 * There is no text to fold into the title and nothing inside to lift out, so
 * without this the press lands on nothing and the key is dead at this boundary
 * for as long as that block is there. Removing it is what the body does with
 * the same press: caret at the end of a paragraph, a divider next, Delete, and
 * the divider goes. Measured on this build.
 * @param state - Current editor state.
 * @param dispatch - Applies the transaction.
 * @returns True when this handled the key.
 */
function removeLeadingLeafBlock(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
): boolean {
  if (state.doc.childCount < 2) return false;
  const boundary = state.doc.child(0).nodeSize;
  const first = state.doc.child(1);
  if (!first.isLeaf) return false;
  if (!dispatch) return true;
  dispatch(
    state.tr.delete(boundary, boundary + first.nodeSize).scrollIntoView(),
  );
  return true;
}

/**
 * Backspace at the very start of the body's first block.
 *
 * This is Enter run backwards, and it is the only way back from an Enter
 * pressed by mistake.
 *
 * A caret at the start of a paragraph nested in a container block passes the
 * gate below — its top-level index IS 1 — and `mergeFirstBodyBlock` is what
 * turns it away, because that block is not a textblock. Declining hands the
 * key to the editor's own Backspace chain, which lifts the paragraph out of
 * its container exactly as it would anywhere else in the body.
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
 * Same join as the Backspace above, reached from the other side — and where
 * that one can decline and leave the key to the editor's own chain, this one
 * cannot: the caret is inside the isolating title, so every default handler
 * stops at the boundary and the press would do nothing whatsoever. So the three
 * below cover the three shapes a block can take — holds text directly, holds no
 * content at all, holds other blocks — and each answers the way the body
 * answers the same press.
 *
 * That is not the same as saying the press always does something. The third
 * one declines when the container will not give its first textblock up: a list
 * whose first item has a sub-list under it, for instance. The body does
 * nothing there either — measured on this build, caret at the end of a
 * paragraph followed by exactly that list — so matching it is the point rather
 * than a gap in the ladder.
 * @param state - Current editor state.
 * @param dispatch - Applies the transaction.
 * @returns True when this handled the key.
 */
const pullBodyIntoTitleEnd: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type.name !== DOCUMENT_TITLE_NODE) return false;
  if ($from.parentOffset !== $from.parent.content.size) return false;
  return (
    mergeFirstBodyBlock(state, dispatch) ||
    removeLeadingLeafBlock(state, dispatch) ||
    liftFirstBodyTextblock(state, dispatch)
  );
};
