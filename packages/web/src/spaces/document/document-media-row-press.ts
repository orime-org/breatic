// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A media block is selected by clicking what it shows (user 2026-10-07).
 *
 * The block's row is as wide as the body, and a picture or a video narrower
 * than the body leaves the rest of the row empty. ProseMirror reads a click
 * anywhere in the row as a click on the block and selects it: a single click
 * through `selectClickedLeaf`, a triple click through `defaultTripleClick`
 * (`prosemirror-view` `input.ts`). A click on the empty part selects nothing:
 * the caret goes to the line under the block, as it does when the focus
 * leaves a selected block (`document-node-selection-focus.ts`). The part that
 * answers is the one the pointer frames on hover: the media and its caption
 * (`[data-media-box]`).
 *
 * Answered at the click, where ProseMirror decides what a click selects. The
 * press before it is left alone, so a drag or a shift-click starting there is
 * the browser's, and the comments' click handlers, which the editor asks
 * first, still close a thread the reader had open.
 */

import { createExtension } from '@blocknote/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { MEDIA_BLOCK_TYPES } from '@web/spaces/document/document-media-types';
import { caretUnder } from '@web/spaces/document/document-node-selection-focus';

const KEY = new PluginKey('documentMediaRowPress');

/** A media block's content element. */
const MEDIA_ROW = MEDIA_BLOCK_TYPES.map((type) => `[data-content-type="${type}"]`).join(', ');

/**
 * Answers a click on the empty part of a media block's row.
 * @param view - The view.
 * @param event - The click.
 * @returns True when the click was on the empty part and is answered here.
 */
function clickBesideMedia(view: EditorView, event: MouseEvent): boolean {
  if (!(event.target instanceof Element)) return false;
  const row = event.target.closest(MEDIA_ROW);
  if (row === null || event.target.closest('[data-media-box]') !== null) return false;
  // The row is the block's content element and starts where the block does;
  // a media block is an atom, so it ends one further on.
  const caret = caretUnder(view.state.doc, view.posAtDOM(row, 0) + 1);
  if (caret !== null) view.dispatch(view.state.tr.setSelection(caret));
  // The row is not editable, so the press gives the body no focus of its own.
  view.focus();
  return true;
}

/**
 * The extension that keeps a click beside a media block from selecting it.
 * @returns The extension, for the assembly to register.
 */
export const documentMediaRowPressExtension = createExtension(() => ({
  key: 'document-media-row-press',
  prosemirrorPlugins: [
    new Plugin({
      key: KEY,
      props: {
        handleClick: (view, _pos, event) => clickBesideMedia(view, event),
        handleDoubleClick: (view, _pos, event) => clickBesideMedia(view, event),
        handleTripleClick: (view, _pos, event) => clickBesideMedia(view, event),
      },
    }),
  ],
}));
