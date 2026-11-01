// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A drag within the body is its paste at the drop point (inner#1351 design
 * §5.4.1): it is put by the paste's own placement (`putContent`), as Slate
 * (`insertData`), Lexical (`$insertDataTransferForRichText`) and CKEditor 5
 * (the clipboard pipeline) put a drop. ProseMirror's own drop inserts the
 * dragged slice as it is (`replaceRange`), which lands otherwise than the
 * paste: words in an empty heading turn it into a paragraph, lines in a code
 * block split it, a table in a cell splits that table.
 *
 * What is put is the drag's own content, which ProseMirror took at dragstart
 * and ran through `transformPasted`: a move keeps its comments and row ids, a
 * copy drops both (`document-comment-paste.ts`, `landingAsDrop`). It is read as its paste
 * reads the body's own copy, each block keeping the node it came from, so the
 * placement puts the body's own words back with their marks.
 *
 * A drop onto the dragged content itself changes nothing, as in CKEditor 5
 * and Lexical; a drag holding no words and no block (a line break alone) is
 * ProseMirror's own drop.
 */

import type { Slice } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { cellAround } from '@tiptap/pm/tables';
import type { EditorView } from '@tiptap/pm/view';

import { t } from '@breatic/shared';

import { toast } from '@web/lib/toast';
import { carriesTable } from '@web/spaces/document/document-drag-move';
import { readBodyContent, type BlockReader } from '@web/spaces/document/document-paste-read';
import { landingAsDrop } from '@web/spaces/document/document-comment-paste';
import { onlyTable, putContent, selectPlaced, type Placed } from '@web/spaces/document/document-put';

/** The editor a drop is put by. */
type Editor = Parameters<typeof putContent>[0] & BlockReader;

/**
 * Puts a drag within the body as its paste at the drop point.
 * @param editor - The editor.
 * @param view - The view.
 * @param event - The drop.
 * @param slice - The dragged content, as ProseMirror hands it to `handleDrop`.
 * @param moved - Whether the drop moves it, as ProseMirror reads the keys at the drop.
 * @returns True when the drop was handled here.
 */
export function dropAsPaste(editor: Editor, view: EditorView, event: DragEvent, slice: Slice, moved: boolean): boolean {
  const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
  if (at === undefined) return false;
  if (slice.content.textBetween(0, slice.content.size, '', '\ufffc') === '') return false;
  const { selection } = view.state;
  if (!selection.empty && at >= selection.from && at <= selection.to) return true;
  const html = view.serializeForClipboard(slice).dom.innerHTML;
  const read = readBodyContent(editor, html, view.state.schema);
  if (cellAround(view.state.doc.resolve(at)) !== null && carriesTable(slice.content) && onlyTable(read.blocks) === null) {
    toast.warning(t('spaces.document.paste.unsupportedInCell'));
    return true;
  }
  let point = at;
  if (moved) {
    const tr = view.state.tr;
    // A node drag carries the node selection it picked up (prosemirror-view
    // `Dragging.node`), which its public type leaves out; ProseMirror's own
    // drop deletes that, else the selection.
    const node = (view.dragging as { node?: { replace: (tr: Transaction) => void } } | null)?.node;
    if (node === undefined) tr.deleteSelection();
    else node.replace(tr);
    point = tr.mapping.map(at);
    view.dispatch(tr);
  }
  // BlockNote's own paste fixes read their target from the selection and stand
  // aside while a drag is in flight (`transformPasted.ts`); the placement puts
  // the selection at the drop point first, so the drag is taken off the view
  // while it puts the drop as a paste there.
  const dragging = view.dragging;
  view.dragging = null;
  let placed: Placed | null;
  try {
    placed = landingAsDrop(moved, () => putContent(editor, read, { wordsIntoTarget: true, judge: (props) => props, dropAt: point }));
  } finally {
    view.dragging = dragging;
  }
  if (placed !== null) selectPlaced(view, placed);
  return true;
}
