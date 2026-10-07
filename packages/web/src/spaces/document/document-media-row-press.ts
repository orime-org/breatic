// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A media block is selected by pressing what it shows (user 2026-10-07).
 *
 * The block's row is as wide as the body, and a picture or a video narrower
 * than the body leaves the rest of the row empty. ProseMirror reads a press
 * anywhere in the row as a press on the block and selects it — a click, a
 * double click or a triple click alike (`prosemirror-view` `input.ts`
 * `selectClickedLeaf`, `defaultTripleClick`). A press on the empty part
 * selects nothing: the caret goes to the line under the block, as it does
 * when the focus leaves a selected block (`document-node-selection-focus.ts`).
 * The part that answers is the one the pointer frames on hover: the media and
 * its caption (`[data-media-box]`).
 */

import { createExtension } from '@blocknote/core';
import { Plugin, PluginKey, Selection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

const KEY = new PluginKey('documentMediaRowPress');

/** The media blocks' content elements. */
const MEDIA_ROW = '[data-content-type="image"], [data-content-type="video"], [data-content-type="audio"]';

/**
 * Answers a press on the empty part of a media block's row.
 * @param view - The view.
 * @param event - The press.
 * @returns True when the press was on the empty part and is answered here.
 */
function pressBesideMedia(view: EditorView, event: MouseEvent): boolean {
  if (event.button !== 0 || !(event.target instanceof Element)) return false;
  const row = event.target.closest(MEDIA_ROW);
  if (row === null || !view.dom.contains(row) || event.target.closest('[data-media-box]') !== null) return false;
  const { doc } = view.state;
  // The row is the block's content element; it starts where the block does.
  const at = view.posAtDOM(row, 0);
  const after = doc.resolve(Math.min(at + (doc.nodeAt(at)?.nodeSize ?? 1), doc.content.size));
  const caret = Selection.findFrom(after, 1, true) ?? Selection.findFrom(after, -1, true);
  event.preventDefault();
  if (caret !== null) view.dispatch(view.state.tr.setSelection(caret));
  view.focus();
  return true;
}

/**
 * The extension that keeps a press beside a media block from selecting it.
 * @returns The extension, for the assembly to register.
 */
export const documentMediaRowPressExtension = createExtension(() => ({
  key: 'document-media-row-press',
  prosemirrorPlugins: [
    new Plugin({
      key: KEY,
      props: {
        handleDOMEvents: {
          mousedown: (view, event) => pressBesideMedia(view, event),
        },
      },
    }),
  ],
}));
