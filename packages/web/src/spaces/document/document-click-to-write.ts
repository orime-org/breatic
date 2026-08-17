// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Clicking the empty space under the last block opens one to type in.
 *
 * A document Space is born holding a title and no body blocks, so without this
 * there is nowhere for the caret to go and the document cannot be written into
 * at all. The same click matters later for a different reason: a code block at
 * the end of the body leaves a user no way to get past it, and
 * this repo deliberately does not run the extension that would append a
 * trailing paragraph on its own — see the note beside `trailingNode: false` in
 * `document-extensions`. Its append is a write to a document everyone shares,
 * fired without anyone asking for it. This one is asked for.
 *
 * ## How the click is recognised
 *
 * Three questions, and all have to answer yes.
 *
 * Was it a click at all? Pressing below the last block and dragging upwards is
 * how a selection gets made from there, and at the moment of the press those
 * two are the same event. So this is decided on release, and a release that
 * left something selected was a drag — the earlier version acted on the press
 * and turned every such selection into an unasked-for paragraph in a document
 * other people are in.
 *
 * Did it land on the editor rather than on a block? ProseMirror gives every
 * block its own element inside the editor's, so an event whose target is the
 * EDITOR itself did not land on one.
 *
 * Is it below the last line? The first question alone is not enough, which is
 * what the first version of this file got wrong. The editor's own box shows
 * through wherever blocks are separated by margin — the title carries 28px of
 * it, and margin belongs to no child's box — so a press in that gap reports the
 * editor as its target while sitting near the TOP of the document. Acting on it
 * appended a paragraph at the far end of the document and dragged the caret and
 * the scroll position down there with it. Reproduced in a real browser on a
 * document with a title and one paragraph before this was written.
 *
 * The vertical edge comes from `coordsAtPos` at the end of the document rather
 * than from the last child element's rectangle: a widget decoration — a remote
 * collaborator's caret — can be a direct child of the editor too, so "the last
 * element" is not reliably the last block, while "the end of the document" is
 * exactly the position this click is asking to reach.
 *
 * ## Why a viewer is turned away here rather than upstream
 *
 * Inserting a block is a write, and a write broadcasts. `setEditable(false)`
 * stops keystrokes; it does not stop a handler of our own. The server drops a
 * viewer's update without an error, so a write that slipped through would
 * leave that one client permanently holding a block nobody else has, with
 * nothing to signal it. This repo has paid for that once already, which is why
 * `trailingNode` is off.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

/**
 * Whether a press sits below everything the document has rendered.
 * @param view - The editor view the press arrived in.
 * @param clientY - Where the press landed vertically.
 * @returns True when it is under the last line rather than beside a block.
 */
function isBelowTheLastLine(view: EditorView, clientY: number): boolean {
  return clientY > view.coordsAtPos(view.state.doc.content.size).bottom;
}

/**
 * Put the caret where the click asked for one, adding a block if needed.
 * @param view - The editor view the click arrived in.
 * @returns True when the click was handled.
 */
function openABlockToTypeIn(view: EditorView): boolean {
  if (!view.editable) return false;
  const paragraph = view.state.schema.nodes['paragraph'];
  if (!paragraph) return false;

  const { doc } = view.state;
  const last = doc.lastChild;
  const tr = view.state.tr;
  // An empty paragraph already at the end is what this click would create, so
  // create nothing and just go there. Otherwise every click on the space below
  // it would stack another.
  const reuse =
    last !== null && last.type === paragraph && last.content.size === 0;
  const caretAt = reuse ? doc.content.size - 1 : doc.content.size + 1;
  if (!reuse) tr.insert(doc.content.size, paragraph.create());
  tr.setSelection(TextSelection.create(tr.doc, caretAt));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

/**
 * Wires the click above into the editor.
 */
export const DocumentClickToWrite = Extension.create({
  name: 'documentClickToWrite',

  /**
   * Watch for a click that landed on the editor, below the last line.
   *
   * `click` rather than `mousedown`: a press is not yet a click, and by the
   * time this fires the editor has resolved what the pointer did — including
   * the selection a drag left behind, which is the one signal that separates
   * the two.
   * @returns The plugin carrying that handler.
   */
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('documentClickToWrite'),
        props: {
          handleDOMEvents: {
            click: (view, event) => {
              if (event.button !== 0) return false;
              // A modifier turns a click into a different gesture — Shift
              // extends the selection, and the others carry their own
              // meanings. None of them says "start writing here", so acting on
              // one would both lose the gesture and write a block nobody asked
              // for into a document other people are in.
              if (
                event.shiftKey ||
                event.ctrlKey ||
                event.altKey ||
                event.metaKey
              ) {
                return false;
              }
              if (event.target !== view.dom) return false;
              // Something got selected, so the pointer dragged rather than
              // clicked. The user was reading, not asking to write.
              if (!view.state.selection.empty) return false;
              if (!isBelowTheLastLine(view, event.clientY)) return false;
              return openABlockToTypeIn(view);
            },
          },
        },
      }),
    ];
  },
});
