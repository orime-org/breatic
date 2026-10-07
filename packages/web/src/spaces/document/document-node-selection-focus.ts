// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A block the reader selected stays selected only while the body holds the
 * focus (user 2026-10-07).
 *
 * A picture, video, audio or divider the reader clicked or arrowed onto is a
 * node selection. When the focus leaves the body — a menu in the top bar, a
 * panel, a click on the page around it — nothing in the document is selected
 * any more, the same way the caret goes away from a text document the reader
 * left. The selection becomes the caret nearest the block, which shows
 * nothing while the body has no focus; when the reader clicks back in, the
 * old block is not drawn as selected for the moment between the press and the
 * new selection.
 *
 * Focus moving to something inside the body is not leaving it: a media
 * block's toolbar and caption are part of the block. The window losing the
 * focus is not either; the reader comes back to the document as they left it.
 */

import { createExtension } from '@blocknote/core';
import { NodeSelection, Plugin, PluginKey, Selection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { DIVIDER } from '@web/spaces/document/document-divider';

/** The blocks the reader selects whole, by a click or an arrow. */
const READER_SELECTED = new Set([DIVIDER, 'image', 'video', 'audio']);

const KEY = new PluginKey('documentNodeSelectionFocus');

/**
 * Puts the caret nearest a block the reader had selected, when the focus has
 * left the body.
 * @param view - The view.
 * @param next - Where the focus went, or null.
 */
function dropWhenFocusLeft(view: EditorView, next: EventTarget | null): void {
  const { selection, doc } = view.state;
  if (!(selection instanceof NodeSelection) || !READER_SELECTED.has(selection.node.type.name)) return;
  if (next instanceof Node && view.dom.contains(next)) return;
  const page = view.dom.ownerDocument;
  // The window itself lost the focus: the body still holds it within the page.
  if (!page.hasFocus()) return;
  const after = doc.resolve(selection.to);
  const caret = Selection.findFrom(after, 1, true) ?? Selection.findFrom(after, -1, true);
  if (caret === null) return;
  view.dispatch(view.state.tr.setSelection(caret).setMeta('addToHistory', false));
}

/**
 * The extension that lets go of a selected block when the body loses focus.
 * @returns The extension, for the assembly to register.
 */
export const documentNodeSelectionFocusExtension = createExtension(() => ({
  key: 'document-node-selection-focus',
  prosemirrorPlugins: [
    new Plugin({
      key: KEY,
      props: {
        handleDOMEvents: {
          focusout: (view, event) => {
            dropWhenFocusLeft(view, event.relatedTarget);
            return false;
          },
        },
      },
    }),
  ],
}));
