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

import { moveRowTo } from '@web/spaces/document/document-drag-move';

/** Which row the drag in flight picked up, if it was a row at all. */
let flying: string | undefined;

/**
 * Says a row drag has started, so the drop knows which row to move.
 *
 * Module state rather than plugin state: the handle is a React component
 * outside the editor, and one drag is in flight at a time per pointer — the
 * browser has one drag at a time, and a second editor on the page has its own
 * plugin instance reading this same answer, which is correct since the reader
 * is dragging the one row.
 * @param blockId - The row that was picked up.
 */
export function rowIsFlying(blockId: string): void {
  flying = blockId;
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
         * @param view - The view the drop happened in.
         * @param event - The drop.
         * @returns True when this handled the drop.
         */
        handleDrop: (view, event) => {
          const blockId = flying;
          if (blockId === undefined) return false;
          // The browser fires `dragend` after `drop`, so the flag is cleared
          // here as well: a drop that this declines must not leave the next
          // text drag looking like a row drag.
          flying = undefined;

          const at = view.posAtCoords({
            left: event.clientX,
            top: event.clientY,
          });
          if (at === null) return false;

          const moved = moveRowTo(view, blockId, at.pos);
          if (moved) event.preventDefault();
          return moved;
        },
      },
    }),
  ],
}) as never);
