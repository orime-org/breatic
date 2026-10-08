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
 * A click beside the media is answered at the browser's `click`, after a
 * press that landed beside it; ProseMirror's own answers to a click there
 * (`handleClick`, `handleDoubleClick`, `handleTripleClick`) pick nothing.
 * ProseMirror cannot be the one to answer it: while the block is selected its
 * row is draggable, and a pointer that moves more than 4px before it is let
 * go makes ProseMirror leave the click to the browser without asking
 * `handleClick`. The press is left alone, so a drag or a shift-click starting
 * there is the browser's, and the comments' click handlers, which the editor
 * asks first, still close a thread the reader had open.
 *
 * A press on the media selects it as it lands, and only then gives the body
 * the focus. While the body has no focus ProseMirror keeps a selection in its
 * state without writing it to the page. On taking the focus back it writes it
 * only when the page's selection changed since it last read it
 * (`prosemirror-view` `input.ts`, `handlers.focus`), and after a click beside
 * the block or the focus leaving it has not: the page keeps the caret on the
 * line under the block, and the click that follows finds the block already
 * selected and writes nothing. `EditorView.focus` writes the state's
 * selection to the page as it focuses, so the block is what the page has
 * selected from the first frame. The press is not otherwise taken: the drag
 * the media starts is the browser's.
 *
 * A click held with the node modifier (Cmd on a Mac, Ctrl elsewhere) is a
 * plain click in this Space (`document-no-node-click.ts`), and in a media row
 * this module answers it as one. A click on the media selects it and is
 * answered here, with any button and with Cmd or Ctrl held, so that
 * ProseMirror's own answer to the modifier — select the node around the one
 * already selected — never runs. A click with Shift held never reaches this
 * module: ProseMirror leaves it to the browser, which extends the selection.
 */

import { createExtension } from '@blocknote/core';
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { MEDIA_BLOCK_TYPES } from '@web/spaces/document/document-media-types';
import { letGoOfBlock } from '@web/spaces/document/document-node-selection-focus';

const KEY = new PluginKey('documentMediaRowPress');

/** The row a view's last left press landed beside the media of, until its click. */
const pressedBeside = new WeakMap<EditorView, Element>();

/** A media block's content element. */
const MEDIA_ROW = MEDIA_BLOCK_TYPES.map((type) => `[data-content-type="${type}"]`).join(', ');

/** Where in a media block's row a press or a click landed. */
interface RowHit {
  /** The row, the block's content element. */
  readonly row: Element;
  /** Whether it landed on what the media shows. */
  readonly onMedia: boolean;
}

/**
 * Where in a media row an event landed.
 * @param target - The event's target.
 * @returns The row and whether the media itself was hit, or null outside a media row.
 */
function rowHit(target: EventTarget | null): RowHit | null {
  if (!(target instanceof Element)) return null;
  const row = target.closest(MEDIA_ROW);
  return row === null ? null : { row, onMedia: target.closest('[data-media-frame]') !== null };
}

/**
 * Whether a click landed in a media block's row, whose clicks this module
 * answers.
 * @param target - Where it landed.
 * @returns True inside a media row.
 */
export function inMediaRow(target: EventTarget | null): boolean {
  return rowHit(target) !== null;
}

/**
 * Node-selects the media block whose row this is.
 * @param view - The view.
 * @param row - The row.
 */
function selectMedia(view: EditorView, row: Element): void {
  const selection = NodeSelection.create(view.state.doc, view.posAtDOM(row, 0));
  if (!view.state.selection.eq(selection)) view.dispatch(view.state.tr.setSelection(selection));
}

/**
 * Answers a click beside the media or on its caption: nothing selected, no
 * focus.
 * @param view - The view.
 * @param row - The row.
 */
function leaveBesideMedia(view: EditorView, row: Element): void {
  // The row is the block's content element and starts where the block does;
  // a media block is an atom, so it ends one further on.
  letGoOfBlock(view, view.posAtDOM(row, 0) + 1);
  (view.dom as HTMLElement).blur();
}

/**
 * ProseMirror's single click in a media block's row: on what the media shows
 * it selects the media; beside it, it picks nothing, the browser's click
 * answers it ({@link clickAfterPressBeside}).
 * @param view - The view.
 * @param event - The click.
 * @returns True when the click landed in a media row.
 */
function clickInMediaRow(view: EditorView, event: MouseEvent): boolean {
  const hit = rowHit(event.target);
  if (hit === null) return false;
  if (hit.onMedia) selectMedia(view, hit.row);
  return true;
}

/**
 * ProseMirror's double or triple click beside the media or on its caption:
 * picks nothing, the browser's click answers it. One on the media is not
 * taken: its press has already selected the media ({@link pressInMediaRow}).
 * @param event - The click.
 * @returns True when the click landed beside the media or on its caption.
 */
function repeatClickBesideMedia(event: MouseEvent): boolean {
  const hit = rowHit(event.target);
  return hit !== null && !hit.onMedia;
}

/**
 * A left press in a media block's row: on what the media shows it selects the
 * media as it lands; beside it, it is noted for the click that follows.
 * @param view - The view.
 * @param event - The press.
 */
function pressInMediaRow(view: EditorView, event: MouseEvent): void {
  pressedBeside.delete(view);
  if (event.button !== 0 || event.shiftKey) return;
  const hit = rowHit(event.target);
  if (hit === null) return;
  if (!hit.onMedia) {
    pressedBeside.set(view, hit.row);
    return;
  }
  selectMedia(view, hit.row);
  if (!view.hasFocus()) view.focus();
}

/**
 * Answers the browser's click after a press beside the media or on its
 * caption, however far the pointer moved: nothing in the body selected, no
 * focus.
 * @param view - The view.
 * @param event - The click.
 */
function clickAfterPressBeside(view: EditorView, event: MouseEvent): void {
  const row = pressedBeside.get(view);
  pressedBeside.delete(view);
  if (row === undefined || event.button !== 0 || event.shiftKey || !row.isConnected) return;
  leaveBesideMedia(view, row);
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
          // The press, not its mousedown: a slider in the player cancels the
          // pointerdown, and a cancelled pointerdown fires no mousedown.
          pointerdown: (view, event) => {
            pressInMediaRow(view, event);
            return false;
          },
          click: (view, event) => {
            clickAfterPressBeside(view, event);
            return false;
          },
        },
        handleClick: (view, _pos, event) => clickInMediaRow(view, event),
        handleDoubleClick: (_view, _pos, event) => repeatClickBesideMedia(event),
        handleTripleClick: (_view, _pos, event) => repeatClickBesideMedia(event),
      },
    }),
  ],
}));
