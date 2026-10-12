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
import { previewRowDrag } from '@web/spaces/document/document-drag-preview';
import {
  readerPlace,
  restoreAfterRowDrag,
} from '@web/spaces/document/document-drag-selection';

/** The editor, as far as moving a row needs it. */
type RowDragEditor = BlockNoteEditor<never, never, never>;

/**
 * Starts moving a row.
 *
 * The drag ends on whichever comes first: a drop anywhere in the page, or the
 * `dragend` the caller passes on. The drop is needed because a row dragged by
 * its own media is redrawn where it lands, and the element the drag started
 * from is gone before its `dragend` fires, so that event never reaches the
 * page. A drag cancelled or dropped outside the page moves nothing, so its
 * `dragend` still arrives.
 * @param editor - The editor.
 * @param event - The `dragstart`.
 * @param event.dataTransfer - What the drag carries.
 * @param event.clientY - Where the pointer is.
 * @param blockId - The row.
 * @returns Ends the drag; calling it again does nothing.
 */
export function startRowDrag(
  editor: RowDragEditor,
  event: { dataTransfer: DataTransfer | null; clientY: number },
  blockId: string,
): () => void {
  const view = editor.prosemirrorView!;
  // Read before the library takes the selection for its own (`blockDragStart`
  // puts a node selection on the row).
  const held = readerPlace(view.state);
  // Which row is in flight, for the drop to read out of the document rather
  // than out of the payload.
  rowIsFlying(blockId, held);
  const sideMenu = editor.getExtension(SideMenuExtension)!;
  sideMenu.blockDragStart(event as never, editor.getBlock(blockId) as never);
  const page = view.dom.ownerDocument;
  previewRowDrag(view, event.dataTransfer, blockId);

  let ended = false;
  /** Ends the drag, once. */
  const end = (): void => {
    if (ended) return;
    ended = true;
    page.removeEventListener('drop', onDrop, true);
    rowHasLanded();
    sideMenu.blockDragEnd();
    // A text selection goes back to whatever the reader had: the node
    // selection the library put on the row at dragstart is still there, and
    // the bubble bar comes up for any selection that is not empty.
    restoreAfterRowDrag(view, held, blockId);
    // A key pressed after the drag has to land in the document.
    focusInPlace(editor);
  };
  /**
   * Seen in the capture phase, before the editor handles the drop; the end
   * waits until that handling is done, since it reads the row in flight.
   */
  const onDrop = (): void => {
    setTimeout(end, 0);
  };
  page.addEventListener('drop', onDrop, true);
  return end;
}

/**
 * Gives the body the focus, leaving everything that scrolls it where it is.
 * WebKit scrolls an editable element to its selection as it takes the focus,
 * `preventScroll` or not, and after a drag the reader's caret is often off
 * screen; the positions are read before and written back after, the way
 * prosemirror-view's `focusPreventScroll` does where `preventScroll` is not
 * honoured (inner#1350 design §5.5).
 * @param editor - The editor.
 */
function focusInPlace(editor: RowDragEditor): void {
  const kept: Array<{ element: Element; top: number; left: number }> = [];
  for (let element: Element | null = editor.prosemirrorView!.dom; element !== null; element = element.parentElement) {
    kept.push({ element, top: element.scrollTop, left: element.scrollLeft });
  }
  editor.focus();
  for (const { element, top, left } of kept) {
    if (element.scrollTop !== top) element.scrollTop = top;
    if (element.scrollLeft !== left) element.scrollLeft = left;
  }
}
