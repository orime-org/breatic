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
 * What is put is the drag's own content as ProseMirror took it at dragstart,
 * read as its paste reads the body's own copy, each block keeping the node it
 * came from, so the placement puts the body's own words back with their
 * marks: a move keeps its comments and row ids, a copy drops both
 * (`document-comment-paste.ts`, `landingSlice`, `landingAsDrop`). A line the
 * move takes only part of keeps its row id where it stays, and the part that
 * moved gets a new one.
 *
 * A drop onto the dragged content itself changes nothing, as in CKEditor 5
 * and Lexical, and so does a drag its paste would put nothing of (line breaks
 * alone, empty lines): nothing is taken away for it.
 */

import type { Slice } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { cellAround } from '@tiptap/pm/tables';
import type { EditorView } from '@tiptap/pm/view';

import { t } from '@breatic/shared';

import { toast } from '@web/lib/toast';
import { readBodyContent, type BlockReader } from '@web/spaces/document/document-paste-read';
import { landingAsDrop, landingSlice, withoutRowIdsIn } from '@web/spaces/document/document-comment-paste';
import { holdsContent, putContent, refusedInCell, selectPlaced, type Placed } from '@web/spaces/document/document-put';
import { tableClippedBlocks } from '@web/spaces/document/document-table-copy';

/** The editor a drop is put by. */
type Editor = Parameters<typeof putContent>[0] & BlockReader;

/**
 * Puts a drag within the body as its paste at the drop point.
 * @param editor - The editor.
 * @param view - The view.
 * @param event - The drop.
 * @param slice - The dragged content as ProseMirror hands it to `handleDrop`, read when the drag's own is not there.
 * @param moved - Whether the drop moves it, as ProseMirror reads the keys at the drop.
 * @returns True when the drop was handled here.
 */
export function dropAsPaste(editor: Editor, view: EditorView, event: DragEvent, slice: Slice, moved: boolean): boolean {
  const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
  if (at === undefined) return false;
  const { selection } = view.state;
  if (!selection.empty && selection.ranges.some(({ $from, $to }) => at >= $from.pos && at <= $to.pos)) return true;
  // A node drag carries the node selection it picked up (prosemirror-view
  // `Dragging.node`), which its public type leaves out; ProseMirror's own drop
  // deletes that, else the selection. With neither (the selection already
  // moved off the dragged content) nothing is taken away, and the drop lands
  // as the copy it then is.
  const node = (view.dragging as { node?: { replace: (tr: Transaction) => void } } | null)?.node;
  const removes = moved && (node !== undefined || !selection.empty);
  const tr = view.state.tr;
  if (removes && node === undefined) tr.deleteSelection();
  else if (removes) node!.replace(tr);
  // The drag's own content as ProseMirror took it at dragstart: the slice it
  // hands over has already been through the paste transforms against the
  // selection the drag began from, and the paste below runs them again
  // against the drop point.
  // A drag of the selection takes what its copy would (words in a cell
  // without the table around them, a range leaving a table with the table).
  const dragged = (node === undefined && !selection.empty ? tableClippedBlocks(view)?.slice : null) ?? view.dragging?.slice ?? slice;
  const content = withoutRowIdsIn(removes ? dragged : landingSlice(dragged, view, true), tr.doc);
  const read = readBodyContent(editor, view.serializeForClipboard(content).dom.innerHTML, view.state.schema);
  if (!holdsContent(read.blocks)) return true;
  if (refusedInCell(cellAround(view.state.doc.resolve(at)) !== null, read.blocks)) {
    toast.warning(t('spaces.document.paste.unsupportedInCell'));
    return true;
  }
  if (removes) view.dispatch(tr);
  const taken = view.state.doc;
  const point = tr.mapping.map(at);
  // BlockNote's own paste fixes read their target from the selection and stand
  // aside while a drag is in flight (`transformPasted.ts`); the placement puts
  // the selection at the drop point first, so the drag is taken off the view
  // while it puts the drop as a paste there.
  const dragging = view.dragging;
  view.dragging = null;
  let placed: Placed | null;
  try {
    placed = landingAsDrop(removes, () => putContent(editor, read, { wordsIntoTarget: true, judge: (props) => props, dropAt: point }));
  } finally {
    view.dragging = dragging;
  }
  // A move whose drop puts nothing gives the dragged content back, as
  // ProseMirror's own drop gives up when its insertion changes nothing.
  if (removes && view.state.doc.eq(taken)) {
    const back = view.state.tr;
    for (let i = tr.steps.length - 1; i >= 0; i -= 1) back.step(tr.steps[i]!.invert(tr.docs[i]!));
    view.dispatch(back.setSelection(selection.getBookmark().resolve(back.doc)));
    return true;
  }
  if (placed !== null) selectPlaced(view, placed);
  return true;
}

