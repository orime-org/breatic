// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The extension that answers a dropped row (A11, design §8).
 *
 * `document-drag-move` decides what is written; this decides when. The two are
 * apart because the first is arithmetic over a document and testable on its
 * own, while this one is a plugin holding one piece of state: which row the
 * drag that is in flight picked up.
 *
 * WHY THE ID IS HELD HERE. `handleDrop` gets the event and the parsed payload,
 * and neither says which row the drag came from — the payload is HTML. The
 * handle tells this extension at dragstart instead, through `rowIsFlying`.
 *
 * A TEXT DRAG IS NOT THIS. When the reader drags a selected word,
 * `view.dragging` is ProseMirror's own and no row was picked up, so this
 * declines and ProseMirror's own handling runs as it always did (A19).
 */

import { createExtension } from '@blocknote/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

import {
  caretAtStartOf,
  restoreReaderPlace,
  type ReaderPlace,
} from '@web/spaces/document/document-drag-selection';
import { moveRowTo } from '@web/spaces/document/document-drag-move';

/** What the drag in flight picked up, if it picked up a row at all. */
interface RowInFlight {
  /** The row being carried. */
  readonly blockId: string;
  /** Where the reader was when they reached for the handle. */
  readonly place: ReaderPlace | undefined;
}

let flying: RowInFlight | undefined;

/**
 * Says a row drag has started, so the drop knows what to move and from where.
 *
 * Module state rather than plugin state: the handle is a React component
 * outside the editor, and one drag is in flight at a time — the browser has
 * one drag at a time, and a second editor on the page has its own plugin
 * instance reading this same answer, which is correct since the reader is
 * dragging the one row.
 * @param blockId - The row that was picked up.
 * @param place - Where the reader's own selection was, if it was a text one.
 */
export function rowIsFlying(
  blockId: string,
  place: ReaderPlace | undefined,
): void {
  flying = { blockId, place };
  // The end of the gesture is heard from the document rather than only from
  // the handle: `dragend` is fired at the source element, and at the Document
  // when that element is no longer in the tree
  // (https://html.spec.whatwg.org/multipage/dnd.html#dndevents), which is what
  // the strip does to the handle when the pointer leaves the row it hangs on.
  // Without this the id would outlive its drag and the next one would carry
  // the wrong row. Registering the same function twice is a no-op per
  // `EventTarget.addEventListener`.
  document.addEventListener('dragend', rowHasLanded, { once: true });
}

/**
 * Says the drag is over, whether it landed or was abandoned.
 */
export function rowHasLanded(): void {
  flying = undefined;
}

/**
 * The extension that writes a dropped row from the document, not the payload.
 * @returns The extension, for the assembly to register.
 */
export const documentDragDropExtension = createExtension(() => ({
  key: 'document-drag-drop',
  prosemirrorPlugins: [
    new Plugin({
      key: new PluginKey('documentDragDrop'),
      props: {
        /**
         * Moves the row the handle picked up to where it was dropped.
         *
         * WHETHER A ROW DRAG STARTED IS THE WHOLE QUESTION. Once one has, the
         * drop is answered here whatever comes of it: handing it back writes
         * the slice `SideMenu.onDragStart` parsed out of `blocknote/html` when
         * the pointer went down (`SideMenu.ts:295-318`), which is the row as
         * it stood then, and ProseMirror finishes by putting a node selection
         * on what it wrote (`prosemirror-view/src/input.ts:820-823`) — the two
         * things §8 and A11.2 exist to keep out. A drop with nothing to write
         * leaves the document as it is.
         * @param view - The view the drop happened in.
         * @param event - The drop.
         * @returns True when this handled the drop.
         */
        handleDrop: (view, event) => {
          const row = flying;
          if (row === undefined) return false;
          // The browser fires `dragend` after `drop`, so the flag is cleared
          // here as well: a drop that this declines must not leave the next
          // text drag looking like a row drag.
          flying = undefined;
          event.preventDefault();

          // The reader's own place goes back BEFORE the move, because an undo
          // item records the selection from before the change that made it
          // (`y-prosemirror/src/plugins/undo-plugin.js`: `prevSel` is read off
          // `oldState` and handed to `stack-item-added`). With the node
          // selection `blockDragStart` leaves on the row still standing, Cmd+Z
          // brought the row back wearing the outline this Space paints for a
          // block the READER selected, with the bubble bar over it — reported
          // 2026-09-18. A selection-only transaction writes nothing to the
          // document, so it adds no undo item of its own.
          restoreReaderPlace(view, row.place ?? caretAtStartOf(row.blockId));

          const at = view.posAtCoords({
            left: event.clientX,
            top: event.clientY,
          });
          if (at !== null) moveRowTo(view, row.blockId, at.pos);
          return true;
        },
      },
    }),
  ],
}) as never);
