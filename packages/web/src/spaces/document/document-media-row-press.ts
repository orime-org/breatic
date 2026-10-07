// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A media block is selected by clicking what it shows (user 2026-10-07).
 *
 * The block's row is as wide as the body, and a picture or a video narrower
 * than the body leaves the rest of the row empty; under the media sits its
 * caption. ProseMirror reads a click anywhere in the row as a click on the
 * block and selects it: a single click through `selectClickedLeaf`, a triple
 * click through `defaultTripleClick` (`prosemirror-view` `input.ts`). Only a
 * click on what the block shows (`[data-media-frame]`; for audio, its player)
 * does that. A click on the empty part or on the caption leaves nothing in
 * the body selected and the body without the focus: the selection becomes a
 * caret, which shows nothing while the body has no focus. The pointer frames
 * the same part on hover (`DocumentMediaBlock.tsx`).
 *
 * A click beside the media is answered at the click, where ProseMirror
 * decides what a click selects. The press before it is left alone, so a drag
 * or a shift-click starting there is the browser's, and the comments' click
 * handlers, which the editor asks first, still close a thread the reader had
 * open.
 *
 * A press on the media selects it as it lands, and only then gives the body
 * the focus. While the body has no focus ProseMirror keeps a selection in its
 * state without writing it to the page, and on taking the focus back it does
 * not write it either: the page keeps the caret it was left with — the line
 * under the block, after a click beside it or after the focus left — and the
 * click that follows finds the block already selected and writes nothing.
 * `EditorView.focus` writes the state's selection to the page as it focuses,
 * so the block is what the page has selected from the first frame. The press
 * is not otherwise taken: the drag the media starts is the browser's.
 */

import { createExtension } from '@blocknote/core';
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { MEDIA_BLOCK_TYPES } from '@web/spaces/document/document-media-types';
import { caretUnder } from '@web/spaces/document/document-node-selection-focus';

const KEY = new PluginKey('documentMediaRowPress');

/** A media block's content element. */
const MEDIA_ROW = MEDIA_BLOCK_TYPES.map((type) => `[data-content-type="${type}"]`).join(', ');

/**
 * Answers a click on a media block's row that is not on what it shows.
 * @param view - The view.
 * @param event - The click.
 * @returns True when the click was beside the media or on its caption, and is answered here.
 */
function clickBesideMedia(view: EditorView, event: MouseEvent): boolean {
  if (!(event.target instanceof Element)) return false;
  const row = event.target.closest(MEDIA_ROW);
  if (row === null || event.target.closest('[data-media-frame]') !== null) return false;
  // The row is the block's content element and starts where the block does;
  // a media block is an atom, so it ends one further on.
  const caret = caretUnder(view.state.doc, view.posAtDOM(row, 0) + 1);
  if (caret !== null) view.dispatch(view.state.tr.setSelection(caret).setMeta('addToHistory', false));
  (view.dom as HTMLElement).blur();
  return true;
}

/**
 * Selects a media block as a press on what it shows lands.
 * @param view - The view.
 * @param event - The press.
 */
function pressOnMedia(view: EditorView, event: MouseEvent): void {
  if (event.button !== 0 || event.shiftKey || !(event.target instanceof Element)) return;
  if (event.target.closest('[data-media-frame]') === null) return;
  const row = event.target.closest(MEDIA_ROW);
  if (row === null) return;
  const selection = NodeSelection.create(view.state.doc, view.posAtDOM(row, 0));
  if (!view.state.selection.eq(selection)) view.dispatch(view.state.tr.setSelection(selection));
  if (!view.hasFocus()) view.focus();
}

/**
 * The extension that selects a media block from a press on what it shows, and from nothing else in its row.
 * @returns The extension, for the assembly to register.
 */
export const documentMediaRowPressExtension = createExtension(() => ({
  key: 'document-media-row-press',
  prosemirrorPlugins: [
    new Plugin({
      key: KEY,
      props: {
        handleDOMEvents: {
          mousedown: (view, event) => {
            pressOnMedia(view, event);
            return false;
          },
        },
        handleClick: (view, _pos, event) => clickBesideMedia(view, event),
        handleDoubleClick: (view, _pos, event) => clickBesideMedia(view, event),
        handleTripleClick: (view, _pos, event) => clickBesideMedia(view, event),
      },
    }),
  ],
}));
