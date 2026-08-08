// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Clicking the empty space under the last block opens one to type in.
 *
 * A document Space is born holding a title and no body blocks, so without this
 * there is nowhere for the caret to go and the document cannot be written into
 * at all. The same click matters later for a different reason: a code block or
 * a divider at the end of the body leaves a user no way to get past it, and
 * this repo deliberately does not run the extension that would append a
 * trailing paragraph on its own — see the note beside `trailingNode: false` in
 * `document-extensions`. Its append is a write to a document everyone shares,
 * fired without anyone asking for it. This one is asked for.
 *
 * ## How the click is recognised
 *
 * By what it landed on, not by where it is. ProseMirror gives every block its
 * own element inside the editor's, so an event whose target is the EDITOR
 * itself landed in the space around the blocks rather than on one. Reading a
 * coordinate and comparing it against the last block's rectangle would say the
 * same thing, but only in a browser — this way the rule is a DOM fact and can
 * be pinned by ordinary tests.
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
   * Watch for a press that landed on the editor rather than on a block.
   *
   * `mousedown` rather than `click`, because the caret has to be in place
   * before the browser starts its own selection from wherever the press was.
   * @returns The plugin carrying that handler.
   */
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('documentClickToWrite'),
        props: {
          handleDOMEvents: {
            mousedown: (view, event) => {
              if (event.button !== 0) return false;
              if (event.target !== view.dom) return false;
              return openABlockToTypeIn(view);
            },
          },
        },
      }),
    ];
  },
});
