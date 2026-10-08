// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every press in an editable body goes through one entry first (inner#1127
 * A20, design 3.5.1 "按下分派表"): it reads what the press is on and decides
 * what the press does to the selection and the focus, before the handlers
 * that act on it run. The entry sits on the body scroller, which is also
 * where a press on blank space leaves the focus (inner#1327): the body lets
 * go, the page keeps scrolling with the keyboard, and Space-level keys such
 * as undo still reach the document.
 */

import { createExtension } from '@blocknote/core';
import { NodeSelection, Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state';
import { columnResizingPluginKey } from '@tiptap/pm/tables';
import type { EditorView } from '@tiptap/pm/view';

import { bodyHolds, layerOf, placeAtLayerAnchor, watchBodyScroll } from '@web/spaces/document/document-body-focus';
import { extendFromPress, followFromPoint } from '@web/spaces/document/document-body-edge-pointer';
import { DOCUMENT_COMMENT_SELECTION, selectedThreadsIn } from '@web/spaces/document/document-comment-selection';
import { MEDIA_CHROME } from '@web/spaces/document/DocumentMediaBlock';
import { MEDIA_BLOCK_TYPES } from '@web/spaces/document/document-media-types';
import { DIVIDER } from '@web/spaces/document/document-divider';
import { SCROLLBAR_MARK } from '@web/components/ui/scroll-area';

/** The attribute on the layout elements beside the body column that count as blank. */
export const BODY_BLANK = 'data-document-body-blank';

/** What a press is on. */
export type PressKind =
  | 'scrollbar'
  | 'layer'
  | 'edge'
  | 'column-resize'
  | 'quiet-control'
  | 'control'
  | 'media'
  | 'divider'
  | 'trailing'
  | 'blank'
  | 'text'
  | 'none';

/** A press as the entry reads it. */
export interface PressTarget {
  readonly kind: PressKind;
  /** The element the kind was read from. */
  readonly element: Element | null;
}

/** The presses the entry took as blank, which ProseMirror then leaves alone. */
const blankPresses = new WeakSet<Event>();

/** The pointer travel past which a press is a drag. */
const CLICK_SLOP = 4;

const MEDIA_ROW = MEDIA_BLOCK_TYPES.map((type) => `[data-content-type="${type}"]`).join(', ');

/**
 * Whether a point is above the first block or below the last one, inside the
 * editable element's width.
 * @param view - The view.
 * @param x - Across.
 * @param y - Down.
 * @returns True on that strip.
 */
function onEdgeStrip(view: EditorView, x: number, y: number): boolean {
  const box = view.dom.getBoundingClientRect();
  if (x < box.left || x > box.right) return false;
  const group = view.dom.querySelector('.bn-block-group');
  const first = group?.firstElementChild?.getBoundingClientRect();
  const last = group?.lastElementChild?.getBoundingClientRect();
  return (first !== undefined && y < first.top) || (last !== undefined && y > last.bottom);
}

/**
 * What a press is on, read top to bottom; the first that matches wins.
 * @param view - The view.
 * @param event - The press.
 * @returns What it is on.
 */
export function pressTargetOf(view: EditorView, event: MouseEvent): PressTarget {
  const target = event.target instanceof Element ? event.target : null;
  if (target === null) return { kind: 'none', element: null };
  const scrollbar = target.closest(`[${SCROLLBAR_MARK}]`);
  if (scrollbar !== null) return { kind: 'scrollbar', element: scrollbar };
  const layer = layerOf(view, target);
  if (layer !== null) return { kind: 'layer', element: layer };
  if (target === view.dom || (view.dom.contains(target) && onEdgeStrip(view, event.clientX, event.clientY))) {
    return { kind: 'edge', element: view.dom };
  }
  if ((columnResizingPluginKey.getState(view.state)?.activeHandle ?? -1) > -1) {
    return { kind: 'column-resize', element: target };
  }
  if (view.dom.contains(target)) {
    const quiet = target.closest('[data-upload-slot], input[type="checkbox"]');
    if (quiet !== null) return { kind: 'quiet-control', element: quiet };
    const control = target.closest(`${MEDIA_CHROME}, input, button, textarea`);
    if (control !== null) return { kind: 'control', element: control };
    const row = target.closest(MEDIA_ROW);
    if (row !== null) {
      return target.closest('[data-media-frame]') !== null
        ? { kind: 'media', element: row }
        : { kind: 'blank', element: row };
    }
    const divider = target.closest(`[data-content-type="${DIVIDER}"]`);
    if (divider !== null) return { kind: 'divider', element: divider };
    const trailing = target.closest('.bn-trailing-block');
    if (trailing !== null) return { kind: 'trailing', element: trailing };
    const table = target.closest('.tableWrapper');
    if (table !== null && target === table) return { kind: 'blank', element: table };
    return { kind: 'text', element: target };
  }
  // Blank only where the layout itself was pressed: the scroller, the
  // gutters beside the column. The comment rail and the document menu sit in
  // the scroller too and are not blank.
  if (target.hasAttribute(BODY_BLANK)) return { kind: 'blank', element: target };
  return { kind: 'none', element: null };
}

/**
 * Whether a press is the context-menu press: the right button, or Control
 * with the main button on a Mac.
 * @param event - The press.
 * @returns True for such a press.
 */
function contextPress(event: MouseEvent): boolean {
  return event.button === 2 || (event.button === 0 && event.ctrlKey && /Mac/.test(navigator.platform));
}

/**
 * Collapses the selection to where a press landed and gives the body the
 * focus, before ProseMirror handles the press: a selection the body does not
 * hold is neither shown between the press and the release nor dragged.
 * @param view - The view.
 * @param event - The press.
 */
function collapseToPress(view: EditorView, event: MouseEvent): void {
  const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
  if (pos !== undefined) {
    const selection = TextSelection.near(view.state.doc.resolve(pos));
    view.dispatch(view.state.tr.setSelection(selection).setMeta('addToHistory', false));
  }
  view.focus();
}

/**
 * Attaches the body scroller: the press entry, the Space-level undo keys and
 * the scroll position a Tab back into the body restores.
 * @param view - The view.
 * @param scroller - The body scroller, which takes the focus a blank press leaves.
 * @param editor - The editor, for undo and redo.
 * @param editor.undo - Undoes the last edit.
 * @param editor.redo - Redoes it.
 * @returns The function that detaches it.
 */
export function attachBodyScroller(
  view: EditorView,
  scroller: HTMLElement,
  editor: { undo: () => unknown; redo: () => unknown },
): () => void {
  scroller.setAttribute(BODY_BLANK, '');
  // Takes the focus from a script and a click, never from Tab.
  scroller.tabIndex = -1;
  const stopScroll = watchBodyScroll(view, scroller);
  let pressed: { x: number; y: number; done: boolean } | null = null;

  /** Ends the press being watched. */
  const endPress = (): void => {
    pressed = null;
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('mouseup', onUp, true);
  };
  /** Gives the focus to the scroller. */
  const leaveBody = (): void => {
    scroller.focus({ preventScroll: true });
  };
  /**
   * Watches a blank press for a drag.
   * @param event - The move.
   */
  const onMove = (event: MouseEvent): void => {
    if (pressed === null || pressed.done) return;
    if (event.buttons === 0) {
      endPress();
      return;
    }
    if (Math.abs(event.clientX - pressed.x) > CLICK_SLOP || Math.abs(event.clientY - pressed.y) > CLICK_SLOP) {
      pressed.done = true;
      followFromPoint(view, pressed.x, pressed.y);
      endPress();
    }
  };
  /** A blank press released without a drag leaves the body. */
  const onUp = (): void => {
    const release = pressed !== null && !pressed.done;
    endPress();
    if (release) leaveBody();
  };
  /**
   * The press entry.
   * @param event - The press.
   */
  const onDown = (event: MouseEvent): void => {
    if (!view.editable || event.button === 1) return;
    const { kind, element } = pressTargetOf(view, event);
    const holds = bodyHolds(view.state);
    switch (kind) {
      case 'layer':
        if (!holds && element !== null) placeAtLayerAnchor(view, event.target as Element);
        return;
      case 'quiet-control':
        event.preventDefault();
        return;
      case 'divider':
        if (!holds && element !== null && !event.shiftKey) {
          view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, view.posAtDOM(element, 0))));
          view.focus();
        }
        return;
      case 'text':
        if (!holds && event.button === 0 && !event.metaKey && !event.altKey) collapseToPress(view, event);
        return;
      case 'edge':
        if (!holds && event.button === 0) {
          const { doc } = view.state;
          const box = view.dom.getBoundingClientRect();
          const atStart = event.clientY < box.top + box.height / 2;
          const selection = atStart ? Selection.atStart(doc) : Selection.atEnd(doc);
          view.dispatch(view.state.tr.setSelection(selection).setMeta('addToHistory', false));
          view.focus();
        }
        return;
      case 'trailing':
        if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
          if (!holds) collapseToPress(view, event);
          return;
        }
        break;
      case 'blank':
        break;
      default:
        return;
    }
    // Blank space: the press is not the browser's, which would snap the
    // selection into the body and give it the focus, nor ProseMirror's, which
    // would select the block and focus the body on the release.
    event.preventDefault();
    blankPresses.add(event);
    // A press that is not on a comment closes the one that was open, the same
    // as a press on plain text (`document-comment-selection.ts`).
    if (selectedThreadsIn(view.state).length > 0) {
      view.dispatch(view.state.tr.setMeta(DOCUMENT_COMMENT_SELECTION, []).setMeta('addToHistory', false));
    }
    if (contextPress(event)) {
      leaveBody();
      return;
    }
    if (event.button !== 0) return;
    if (event.shiftKey && holds) {
      extendFromPress(view, event);
      return;
    }
    endPress();
    pressed = { x: event.clientX, y: event.clientY, done: false };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  };
  /**
   * Undo and redo while the scroller itself has the focus.
   * @param event - The key.
   */
  const onKey = (event: KeyboardEvent): void => {
    if (event.target !== scroller || !(event.metaKey || event.ctrlKey)) return;
    const key = event.key.toLowerCase();
    if (key === 'z' && !event.shiftKey) {
      editor.undo();
    } else if ((key === 'z' && event.shiftKey) || (key === 'y' && event.ctrlKey && !event.metaKey)) {
      editor.redo();
    } else {
      return;
    }
    event.preventDefault();
  };
  scroller.addEventListener('mousedown', onDown, true);
  scroller.addEventListener('contextmenu', endPress, true);
  scroller.addEventListener('keydown', onKey);
  return () => {
    endPress();
    stopScroll();
    scroller.removeEventListener('mousedown', onDown, true);
    scroller.removeEventListener('contextmenu', endPress, true);
    scroller.removeEventListener('keydown', onKey);
  };
}

/**
 * The extension that keeps ProseMirror off a press the body's entry took as
 * blank (the empty part of a media row, a caption, a table's frame).
 * @returns The extension, for the assembly to register.
 */
export const documentBlankPressExtension = createExtension(() => ({
  key: 'document-blank-press',
  prosemirrorPlugins: [
    new Plugin({
      key: new PluginKey('documentBlankPress'),
      props: {
        handleDOMEvents: {
          mousedown: (_view, event) => blankPresses.has(event),
        },
      },
    }),
  ],
}));
