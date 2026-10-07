// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Moving one row by dragging it: the block handle starts it from its grip, and
 * a media block from its picture, video or audio (inner#1127). Both run these
 * two steps, so a row moves the same way whichever was pressed.
 */

import type { BlockNoteEditor } from '@blocknote/core';
import { SideMenuExtension } from '@blocknote/core/extensions';

import { rowHasLanded, rowIsFlying } from '@web/spaces/document/document-drag-drop';
import {
  caretAtStartOf,
  readerPlace,
  restoreReaderPlace,
  type ReaderPlace,
} from '@web/spaces/document/document-drag-selection';

/** The editor, as far as moving a row needs it. */
type RowDragEditor = BlockNoteEditor<never, never, never>;

/**
 * Starts moving a row.
 * @param editor - The editor.
 * @param event - The `dragstart`.
 * @param event.dataTransfer - What the drag carries.
 * @param event.clientY - Where the pointer is.
 * @param blockId - The row.
 * @returns Where the reader was, to hand back when the drag ends.
 */
export function startRowDrag(
  editor: RowDragEditor,
  event: { dataTransfer: DataTransfer | null; clientY: number },
  blockId: string,
): ReaderPlace | undefined {
  // Read before the library takes the selection for its own (`blockDragStart`
  // puts a node selection on the row).
  const place = readerPlace(editor.prosemirrorView!.state);
  // Which row is in flight, for the drop to read out of the document rather
  // than out of the payload.
  rowIsFlying(blockId, place);
  editor.getExtension(SideMenuExtension)!.blockDragStart(event as never, editor.getBlock(blockId) as never);
  return place;
}

/**
 * Ends moving a row, wherever it landed.
 *
 * A text selection goes back to whatever the reader had: the node selection
 * the library put on the row at dragstart is still there when the drag ends,
 * and the bubble bar comes up for any selection that is not empty. The
 * reader's own place when there was one; the caret in the row that moved when
 * there was not.
 * @param editor - The editor.
 * @param blockId - The row.
 * @param held - Where the reader was when it started.
 */
export function endRowDrag(editor: RowDragEditor, blockId: string, held: ReaderPlace | undefined): void {
  rowHasLanded();
  editor.getExtension(SideMenuExtension)!.blockDragEnd();
  restoreReaderPlace(editor.prosemirrorView!, held ?? caretAtStartOf(blockId));
  // A key pressed after the drag has to land in the document.
  editor.focus();
}
