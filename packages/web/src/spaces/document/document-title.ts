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
 * cursor with nowhere to type. The left arrow works by itself without it. The
 * cross-boundary Enter does not — it throws on its own, and is answered by
 * hand in `claimEnterInsideTitle` below.
 *
 * Those hand-written branches are gone with it. Dropping the property is what
 * made them redundant, and they outlived it by a round because nothing went red
 * when it left — which is worth remembering the next time a property this load-
 * bearing is removed: what it forced has to be re-derived, not just re-read.
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
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { joinForward, splitBlock } from '@tiptap/pm/commands';
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

  /**
   * Ahead of the editing feature set, so the title's keys are decided first.
   *
   * The keys below all decline outside the title, so what this changes is one
   * thing: inside it, they are asked before StarterKit is. That matters for
   * Enter, because TipTap's input-rule plugin also handles Enter — it runs the
   * rules with the text `"\n"` — and it reports the key as handled whether or
   * not its transaction survives. Measured with the default ordering: `***` in
   * the title followed by Enter emptied the title AND swallowed the Enter, and
   * with the title guard rejecting the rule's transaction the title survived
   * but the Enter was still swallowed. Deciding the title's keys first is what
   * makes the press do what the title says it does.
   */
  priority: 1000,
  parseHTML: () => [{ tag: `h1.${DOCUMENT_TITLE_CLASS}` }],
  renderHTML: () => ['h1', { class: DOCUMENT_TITLE_CLASS }, 0],

  /**
   * The keys that cross the line between the title and the body.
   *
   * All three are thin, and each is thin for its own reason. Everything else
   * about this boundary — the cut, the fold from either side, lifting a list's
   * first item out — is the editor's own and needs nothing
   * from here. That is a measurement, not a reading: with all three removed,
   * 25 of the 32 cases in `document-title-keymap.test` still pass
   * (remeasured 2026-08-17, after this branch dropped the divider cases).
   *
   * What each one is for, and what goes red without it:
   *
   * Enter claims the key so that something else cannot, and hands the work
   * straight back to the editor. It also answers a selection that ends outside
   * the title, where the editor's own split throws.
   *
   * Backspace and Delete decline unless the fold would lose a soft line break.
   * Delete answers one thing more: with the title empty, the editor never gets
   * the chance, because `deleteCurrentNode` runs ahead of `joinForward` and
   * takes an empty block as its own.
   *
   * Vertical arrows are not here. Moving the caret up and down in a
   * contenteditable is the browser's own behaviour, not something key handling
   * sees, and the title is an ordinary editable block as far as the browser is
   * concerned — so nothing needs doing, and nothing here could do it.
   * @returns The key bindings, by key name.
   */
  addKeyboardShortcuts() {
    return {
      Enter: asShortcut(this.editor, claimEnterInsideTitle),
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
 * Claim Enter while the caret is in the title, and split the way the editor
 * would have.
 *
 * What it does with a plain cursor is not ours — `splitBlock` is the editor's
 * own, and the title needs no help from it: the document's content rule is
 * `title block*`, so a split of the first block cannot produce a second title
 * and falls to a paragraph, and `defining` keeps the title's own text where it
 * is. Every one of the boundary suite's cursor cases passes with this binding
 * removed.
 *
 * Two things are ours. The first is the claim. TipTap's input-rule plugin handles Enter too — it
 * runs the rules with the text `"\n"` — and it reports the key as handled
 * whether or not its transaction survives. So with Enter unclaimed here,
 * typing `***` in the title and pressing Enter does nothing at all: the rule
 * matches, the title guard rejects what it built, and the press is gone with
 * it. Claiming the key at this node's priority is what settles that, which is
 * why this exists and why it is this thin.
 *
 * The second is the selection that ends outside the title, below.
 *
 * Measured by removing this binding: three cases go red — the cross-boundary
 * selection here, and `***` or `___` in the title followed by Enter.
 * @param state - Current editor state.
 * @param dispatch - Applies the transaction.
 * @returns True when this handled the key.
 */
const claimEnterInsideTitle: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if ($from.parent.type.name !== DOCUMENT_TITLE_NODE) return false;
  if (state.selection.empty) return splitBlock(state, dispatch);
  if (!dispatch) return true;

  // A selection that ends outside the title cannot be left to the editor: its
  // own split throws on that shape — measured, "Inserted content deeper than
  // insertion position" — and the press does nothing at all. Replacing the
  // selection first is what any key does over one, and it leaves a caret the
  // editor's own split then handles.
  const tr = state.tr;
  tr.deleteSelection();
  const afterDelete = state.apply(tr);
  splitBlock(afterDelete, (splitTr) => {
    splitTr.steps.forEach((step) => {
      tr.step(step);
    });
    tr.setSelection(Selection.fromJSON(tr.doc, splitTr.selection.toJSON()));
  });
  dispatch(tr.scrollIntoView());
  return true;
};

/**
 * The block's text, with a space wherever something that is not text separated
 * two runs of it.
 *
 * A soft line break carries no text of its own, so copying only text would run
 * the lines either side of it into one word. A break with nothing on one side
 * separates nothing, and a space there would be one the user never typed.
 * @param block - The block to flatten.
 * @returns The text the title would receive.
 */
function flattenToTitleText(block: ProseMirrorNode): string {
  let text = '';
  let separated = false;
  block.content.forEach((child) => {
    if (!child.isText) {
      separated = true;
      return;
    }
    if (separated && text.length > 0) text += ' ';
    separated = false;
    text += child.text ?? '';
  });
  return text;
}

/**
 * Fold the body's first block into the title, keeping what is not text visible.
 *
 * This is one of the two things the two keys below add; the other is the
 * empty-title Delete, in `pullBodyIntoTitleEnd`. Everything else they do is
 * the editor's own — see the binding list above for the measurement.
 *
 * The reason the rest became the editor's is that the title stopped being
 * `isolating`. While it was, every default handler bailed at the boundary and
 * each gesture had to be written out by hand; the ladder those hand-written
 * branches formed outlived the property that forced it.
 *
 * What the default cannot do is this: the title's content is text and nothing
 * else, so a soft line break in the block being folded in has nowhere to go and
 * the editor drops it, gluing the two lines into one word. A space is what it
 * becomes instead. Text arrives unmarked for the same reason — the title holds
 * no marks — and that part the default already gets right.
 * @param state - Current editor state.
 * @param dispatch - Applies the transaction.
 * @returns True when this handled the key, false to leave it to the editor.
 */
function mergeAcrossSoftBreak(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
): boolean {
  if (state.doc.childCount < 2) return false;
  const title = state.doc.child(0);
  const first = state.doc.child(1);
  // A container block holds textblocks of its own; folding one in would delete
  // every one of them. The editor lifts its first textblock out instead, and
  // declining is what lets it.
  if (!first.isTextblock) return false;
  const text = flattenToTitleText(first);
  // Nothing to add: the editor's own merge produces this already, and letting
  // it do so keeps every case it handles better than this could.
  if (text === first.textContent) return false;
  if (!dispatch) return true;

  const titleContentEnd = 1 + title.content.size;
  const tr = state.tr;
  tr.delete(title.nodeSize, title.nodeSize + first.nodeSize);
  if (text) tr.insert(titleContentEnd, state.schema.text(text));
  tr.setSelection(TextSelection.create(tr.doc, titleContentEnd));
  dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Backspace at the very start of the body's first block.
 *
 * Declining is the normal outcome and the right one: the editor's own Backspace
 * chain folds that block into the title already. This is here for the one thing
 * it does differently — see {@link mergeAcrossSoftBreak}.
 * @param state - Current editor state.
 * @param dispatch - Applies the transaction.
 * @returns True when this handled the key.
 */
const mergeBodyStartIntoTitle: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0 || $from.index(0) !== 1) return false;
  return mergeAcrossSoftBreak(state, dispatch);
};

/**
 * Delete at the end of the title — the same fold, reached from the other side.
 *
 * Declines for the same reasons and leaves the key to the editor, which pulls
 * the body's first block up or lifts a container's first textblock out,
 * exactly as it does at every other boundary in the body.
 * @param state - Current editor state.
 * @param dispatch - Applies the transaction.
 * @returns True when this handled the key.
 */
const pullBodyIntoTitleEnd: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type.name !== DOCUMENT_TITLE_NODE) return false;
  if ($from.parentOffset !== $from.parent.content.size) return false;
  if (mergeAcrossSoftBreak(state, dispatch)) return true;
  // With text in the title the editor answers this key correctly on its own.
  // With none, it does not get the chance: `deleteCurrentNode` runs ahead of
  // `joinForward` and takes an empty block as its own — it tries to delete the
  // title, the schema refuses, and it reports the key handled with nothing
  // done. An empty title is a state the product supports (the placeholder
  // exists for it), so the key is answered here by running the step that was
  // skipped.
  if ($from.parent.content.size === 0) return joinForward(state, dispatch);
  return false;
};
