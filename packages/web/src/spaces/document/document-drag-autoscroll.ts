// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Wires the body's autoscroll (`document-body-autoscroll.ts`) to the page
 * (inner#1350 design §5.2).
 *
 * A drag session starts on any `dragstart` nobody cancelled — a cancelled one
 * starts no drag and would never end — and on content dragged in from outside
 * the window. It reads the pointer off `dragover` and ends on `drop`,
 * `dragend` or the first `mousemove`: a live drag produces no mouse events, and
 * a drag whose source left the page, or one from another application, has no
 * `dragend` that reaches the document (`document-table-drag.ts` ends its drag
 * the same way). A `dragleave` to nothing is the pointer leaving the window.
 *
 * The pointer is read off `dragenter` as well as `dragover`: each drag update
 * in Chrome fires `dragenter` when the element under the pointer changed and
 * `dragover` only when it did not (`event_handler.cc` `UpdateDragAndDrop`).
 * Events BlockNote re-dispatches are skipped: it marks them `synthetic` and
 * clamps their pointer into the editor (`SideMenu.ts` `dispatchSyntheticEvent`),
 * so they would read a pointer over the Agent column as one over the body.
 *
 * A column drag scrolls the frame its table scrolls sideways in; everything
 * else scrolls the body.
 *
 * A pulled selection's session is started and ended by the pointer follower
 * (`document-body-edge-pointer.ts`), which knows when it took a press from the
 * browser; this file only feeds it the pointer.
 */

import { createExtension } from '@blocknote/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { BodyAutoScroll, type DragTarget } from '@web/spaces/document/document-body-autoscroll';
import { dragSourceOf } from '@web/spaces/document/document-table-drag';

/** The element a scroll area scrolls. */
const SCROLL_VIEWPORT = '[data-radix-scroll-area-viewport]';

/**
 * Whether an event is one BlockNote re-dispatched, by the mark it sets.
 * @param event - The event.
 * @returns Whether it is synthetic.
 */
function isSynthetic(event: Event): boolean {
  return (event as Event & { synthetic?: boolean }).synthetic === true;
}

/** Each view's session loop. */
const sessions = new WeakMap<EditorView, BodyAutoScroll>();

/**
 * The autoscroll loop of a view.
 * @param view - The editor view.
 * @returns The loop, or undefined when the extension is not on the view.
 */
export function autoScrollOf(view: EditorView): BodyAutoScroll | undefined {
  return sessions.get(view);
}

/**
 * The element the body scrolls in.
 * @param view - The editor view.
 * @returns The scroller, or null when the body is not in one.
 */
export function bodyScrollerOf(view: EditorView): HTMLElement | null {
  return view.dom.closest<HTMLElement>(SCROLL_VIEWPORT);
}

/**
 * What a drag that just started scrolls: a column drag its table's frame,
 * sideways; anything else the body.
 * @param view - The editor view.
 * @returns The target, or null when there is nothing to scroll.
 */
function dragTargetOf(view: EditorView): DragTarget | null {
  const source = dragSourceOf(view.state);
  if (source?.orientation === 'column') {
    const cell = view.nodeDOM(source.cellPos);
    const frame = cell instanceof Element ? cell.closest<HTMLElement>(SCROLL_VIEWPORT) : null;
    if (frame !== null) return { el: frame, axis: 'x', gate: false };
  }
  const body = bodyScrollerOf(view);
  return body === null ? null : { el: body, axis: 'y', gate: true };
}

/**
 * Listens on the page for one view's drags.
 * @param view - The editor view.
 * @param auto - Its loop.
 * @returns Stops listening.
 */
function listen(view: EditorView, auto: BodyAutoScroll): () => void {
  const page = view.dom.ownerDocument;
  const win = page.defaultView;
  /**
   * Starts a drag nobody cancelled.
   * @param event - The dragstart.
   */
  const onDragStart = (event: Event): void => {
    if (event.defaultPrevented || isSynthetic(event)) return;
    const target = dragTargetOf(view);
    if (target !== null) auto.beginDrag(target);
  };
  /**
   * Starts a drag that comes in from outside the window, and feeds the pointer.
   * @param event - The dragenter.
   */
  const onDragEnter = (event: Event): void => {
    if (isSynthetic(event)) return;
    if (auto.state === 'idle') {
      if ((event as MouseEvent).relatedTarget !== null) return;
      const target = dragTargetOf(view);
      if (target === null) return;
      auto.beginDrag(target);
    }
    onDragOver(event);
  };
  /**
   * Feeds the pointer.
   * @param event - The dragover or dragenter.
   */
  function onDragOver(event: Event): void {
    if (isSynthetic(event)) return;
    const { clientX, clientY } = event as MouseEvent;
    auto.follow({ x: clientX, y: clientY });
  }
  /**
   * Notes the pointer leaving the window.
   * @param event - The dragleave.
   */
  const onDragLeave = (event: Event): void => {
    if ((event as MouseEvent).relatedTarget === null) auto.leaveWindow();
  };
  /**
   * Ends a drag.
   * @param event - The drop or dragend.
   */
  const onDragDone = (event: Event): void => {
    if (!isSynthetic(event)) auto.end('drag');
  };
  /**
   * Ends a drag that is over, or feeds a pulled selection.
   * @param event - The mousemove.
   */
  const onMouseMove = (event: MouseEvent): void => {
    if (auto.source === 'drag') auto.end('drag');
    else if (auto.source === 'press') auto.follow({ x: event.clientX, y: event.clientY });
  };
  page.addEventListener('dragstart', onDragStart);
  page.addEventListener('dragenter', onDragEnter, true);
  page.addEventListener('dragover', onDragOver, true);
  page.addEventListener('drop', onDragDone, true);
  page.addEventListener('dragend', onDragDone, true);
  win?.addEventListener('dragleave', onDragLeave, true);
  win?.addEventListener('mousemove', onMouseMove, true);
  return () => {
    page.removeEventListener('dragstart', onDragStart);
    page.removeEventListener('dragenter', onDragEnter, true);
    page.removeEventListener('dragover', onDragOver, true);
    page.removeEventListener('drop', onDragDone, true);
    page.removeEventListener('dragend', onDragDone, true);
    win?.removeEventListener('dragleave', onDragLeave, true);
    win?.removeEventListener('mousemove', onMouseMove, true);
  };
}

/**
 * The extension that scrolls the body while something is dragged over it.
 * @returns The extension, for the assembly to register.
 */
export const documentDragAutoScrollExtension = createExtension(() => ({
  key: 'document-drag-autoscroll',
  prosemirrorPlugins: [
    new Plugin({
      key: new PluginKey('documentDragAutoScroll'),
      view: (view) => {
        const win = view.dom.ownerDocument.defaultView;
        const auto = new BodyAutoScroll({
          requestFrame: (cb) => win?.requestAnimationFrame(cb) ?? 0,
          cancelFrame: (id) => {
            win?.cancelAnimationFrame(id);
          },
          viewport: () => ({ width: win?.innerWidth ?? 0, height: win?.innerHeight ?? 0 }),
        });
        sessions.set(view, auto);
        const stop = listen(view, auto);
        return {
          destroy: () => {
            stop();
            auto.end();
            sessions.delete(view);
          },
        };
      },
    }),
  ],
}));
