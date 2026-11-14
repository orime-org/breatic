// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A block drag over the body's scroll area, however far into the page margin,
 * lands on the row at the pointer's height (inner#1314 design §5.2).
 *
 * BlockNote re-sends a block drag beside the body to the body, held to its
 * box, only within its `dropMargin` of the editor
 * (`SideMenu/blockDropHandling.ts`); beyond that, and on its first answer, it
 * sends a `dragleave` that clears the line. Further out in the scroll area the
 * same re-send is made here, on the window after the library's own listeners
 * on the document have run.
 */

import { createExtension } from '@blocknote/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

/** How far from the editor BlockNote itself re-sends a block drag. */
export const DROP_MARGIN = 250;

/** The body's scroll area, which a block drag lands on to its full width. */
const SCROLLER = '[data-radix-scroll-area-viewport]';

/**
 * How far a point is from a box.
 * @param x - The point's x.
 * @param y - The point's y.
 * @param box - The box.
 * @returns The distance, 0 inside.
 */
function distanceTo(x: number, y: number, box: DOMRect): number {
  return Math.hypot(Math.max(box.left - x, 0, x - box.right), Math.max(box.top - y, 0, y - box.bottom));
}

/**
 * Re-sends a drag event to the body, held to the body's box, as BlockNote
 * does within its margin.
 * @param view - The editor view.
 * @param event - The drag event over the scroll area.
 */
function resend(view: EditorView, event: DragEvent): void {
  const box = (view.dom.firstElementChild ?? view.dom).getBoundingClientRect();
  const held = Object.assign(new Event(event.type, event), {
    clientX: Math.min(Math.max(event.clientX, box.left), box.right),
    clientY: Math.min(Math.max(event.clientY, box.top), box.bottom),
    dataTransfer: event.dataTransfer,
    preventDefault: () => event.preventDefault(),
    synthetic: true,
  });
  view.dom.dispatchEvent(held);
}

/**
 * The extension that lands block drags anywhere in the body's scroll area.
 * @returns The extension, for the assembly to register.
 */
export const documentMarginDropExtension = createExtension(() => ({
  key: 'document-margin-drop',
  prosemirrorPlugins: [
    new Plugin({
      key: new PluginKey('documentMarginDrop'),
      view: (view) => {
        const win = view.dom.ownerDocument.defaultView;
        /**
         * Re-sends a block drag out in the scroll area, beyond BlockNote's reach.
         * @param event - The drag event.
         */
        const onDrag = (event: DragEvent): void => {
          if (view.dragging === null || (event as { synthetic?: boolean }).synthetic === true) return;
          const target = event.target instanceof Node ? event.target : null;
          if (target === null || view.dom.contains(target)) return;
          const scroller = view.dom.closest(SCROLLER);
          if (scroller === null || !scroller.contains(target)) return;
          if (distanceTo(event.clientX, event.clientY, view.dom.getBoundingClientRect()) <= DROP_MARGIN) return;
          resend(view, event);
        };
        win?.addEventListener('dragover', onDrag);
        win?.addEventListener('drop', onDrag);
        return {
          destroy: () => {
            win?.removeEventListener('dragover', onDrag);
            win?.removeEventListener('drop', onDrag);
          },
        };
      },
    }),
  ],
}));
