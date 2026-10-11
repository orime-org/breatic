// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Wires the body's autoscroll (`document-body-autoscroll.ts`) to the page
 * (inner#1350 design §5.2).
 *
 * A drag session starts on any `dragstart` nobody cancelled — a cancelled one
 * starts no drag and would never end — and on content dragged in from outside
 * the window. It reads the pointer off `dragover` and ends on `drop`,
 * `dragend` or the first `mousemove` with no button held: a drag whose button is up is over, and
 * a drag whose source left the page, or one from another application, has no
 * `dragend` that reaches the document (`document-table-drag.ts` ends its drag
 * the same way). The pointer leaving the window is told the way Pragmatic drag
 * and drop tells it (`is-leaving-window.js`): a `dragleave` to nothing, and in
 * Safari, whose `relatedTarget` is always null (WebKit bug 242627), the count
 * of `dragenter` against `dragleave` coming back to nothing
 * (`count-events-for-safari.js`).
 *
 * The pointer is read off `dragenter` as well as `dragover`: each drag update
 * in Chrome fires `dragenter` when the element under the pointer changed and
 * `dragover` only when it did not (`event_handler.cc` `UpdateDragAndDrop`).
 * Events BlockNote re-dispatches are skipped: it marks them `synthetic` and
 * clamps their pointer into the editor (`SideMenu.ts` `dispatchSyntheticEvent`),
 * so they would read a pointer over the Agent column as one over the body.
 *
 * A column drag scrolls the frame its table scrolls sideways in, and holds
 * the body still: the browser's own drag autoscroll scrolls any box a reader
 * could scroll that the pointer nears, and one with `overflow-y: hidden` is not
 * one. Everything else scrolls the body.
 *
 * A pulled selection's session belongs to the pointer follower
 * (`document-body-edge-pointer.ts`), which knows when it took a press from the
 * browser.
 */

import { createExtension } from '@blocknote/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import {
  BodyAutoScroll,
  bodyScrollerOf,
  type DragTarget,
} from '@web/spaces/document/document-body-autoscroll';
import { dragSourceOf, tableFrameOf } from '@web/spaces/document/document-table-drag';

/**
 * Whether an event is one BlockNote re-dispatched, by the mark it sets.
 * @param event - The event.
 * @returns Whether it is synthetic.
 */
function isSynthetic(event: Event): boolean {
  return (event as Event & { synthetic?: boolean }).synthetic === true;
}

/**
 * Whether the browser's drag events leave the window only by their count:
 * Safari, the way Pragmatic drag and drop tells it (`is-safari.js`).
 * @param userAgent - The browser's user agent.
 * @returns Whether to count.
 */
export function countsDragEvents(userAgent: string): boolean {
  return userAgent.includes('AppleWebKit') && !userAgent.includes('Chrome');
}

/** Whether a drag's pointer is leaving the window, one `dragleave` at a time. */
export class DragWindow {
  private entered = 0;
  private over = false;

  /**
   * Tells leaving the window by count or by relatedTarget.
   * @param counts - Whether to tell it by counting (Safari).
   */
  constructor(private readonly counts: boolean) {}

  /** A drag started in this window. */
  start(): void {
    this.entered = 0;
    this.over = true;
  }

  /** A drag ended. */
  reset(): void {
    this.entered = 0;
    this.over = false;
  }

  /** The pointer entered an element. */
  enter(): void {
    this.over = true;
    this.entered += 1;
  }

  /**
   * Whether this `dragleave` is the pointer leaving the window.
   * @param event - The dragleave.
   * @returns Whether it leaves.
   */
  leaves(event: MouseEvent): boolean {
    if (!this.counts) return event.relatedTarget == null;
    this.entered -= 1;
    if (!this.over || this.entered > 0) return false;
    this.over = false;
    return true;
  }
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
 * What a drag that just started scrolls: a column drag its table's frame,
 * sideways; anything else the body.
 * @param view - The editor view.
 * @returns The target, or null when there is nothing to scroll.
 */
function dragTargetOf(view: EditorView): DragTarget | null {
  const source = dragSourceOf(view.state);
  if (source?.orientation === 'column') {
    const frame = tableFrameOf(view, source.cellPos);
    if (frame !== null) return { el: frame, axis: 'x' };
  }
  const body = bodyScrollerOf(view);
  return body === null ? null : { el: body, axis: 'y' };
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
  const dragWindow = new DragWindow(countsDragEvents(win?.navigator.userAgent ?? ''));
  /** Gives the body back its own vertical overflow, after a column drag. */
  let releaseBody: (() => void) | null = null;
  /**
   * Starts a drag session on a target, holding the body still under a column drag.
   * @param target - What it scrolls.
   */
  const begin = (target: DragTarget): void => {
    auto.beginDrag(target);
    const body = bodyScrollerOf(view);
    if (target.axis !== 'x' || body === null || releaseBody !== null) return;
    const own = body.style.overflowY;
    body.style.overflowY = 'hidden';
    releaseBody = () => {
      body.style.overflowY = own;
    };
  };
  /** Ends the drag session. */
  const endDrag = (): void => {
    auto.end('drag');
    dragWindow.reset();
    releaseBody?.();
    releaseBody = null;
  };
  /**
   * Starts a drag nobody cancelled.
   * @param event - The dragstart.
   */
  const onDragStart = (event: Event): void => {
    if (event.defaultPrevented || isSynthetic(event)) return;
    dragWindow.start();
    const target = dragTargetOf(view);
    if (target !== null) begin(target);
  };
  /**
   * Starts a drag that comes in from outside the window, and feeds the pointer.
   * @param event - The dragenter.
   */
  const onDragEnter = (event: Event): void => {
    if (isSynthetic(event)) return;
    dragWindow.enter();
    if (auto.state === 'idle') {
      if ((event as MouseEvent).relatedTarget !== null) return;
      const target = dragTargetOf(view);
      if (target === null) return;
      begin(target);
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
    if (!isSynthetic(event) && dragWindow.leaves(event as MouseEvent)) auto.leaveWindow();
  };
  /**
   * Ends a drag.
   * @param event - The drop or dragend.
   */
  const onDragDone = (event: Event): void => {
    if (!isSynthetic(event)) endDrag();
  };
  /**
   * Ends a drag that is over: the first move with no button held. Firefox lets
   * a few pointer events through after a drag starts, the button still held
   * (Pragmatic drag and drop `detect-broken-drag.js`).
   * @param event - The mousemove.
   */
  const onMouseMove = (event: MouseEvent): void => {
    if (auto.source === 'drag' && event.buttons === 0) endDrag();
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
    releaseBody?.();
    releaseBody = null;
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
