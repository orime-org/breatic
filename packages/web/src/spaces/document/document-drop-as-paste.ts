// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A drag within the body is its paste at the drop point (inner#1351 design
 * §5.4.1): it is put by the paste's own placement (`putContent`), as Slate
 * (`insertData`), Lexical (`$insertDataTransferForRichText`) and CKEditor 5
 * (the clipboard pipeline) put a drop. ProseMirror's own drop inserts the
 * dragged slice as it is (`replaceRange`), which lands otherwise than the
 * paste: words in an empty heading turn it into a paragraph, lines in a code
 * block split it, a table in a cell splits that table.
 *
 * What is put is the drag's own slice as ProseMirror took it at dragstart,
 * what its copy would carry (`transformCopied`), placed as it is: its nodes
 * are the body's own, so a move keeps its comments and row ids and a copy
 * drops both (`document-comment-paste.ts`, `landingSlice`, `landingAsDrop`),
 * settled at the drop point. A line the move takes only part of keeps its row
 * id where it stays, and the part that moved gets a new one.
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
import { landingAsDrop, landingSlice, withoutRowIdsIn } from '@web/spaces/document/document-comment-paste';
import { readClipboardSlice, rowsOf } from '@web/spaces/document/document-paste-slice';
import { deleteStoredTableRange, storedTableRange } from '@web/spaces/document/document-table-copy';
import { holdsContent, holdsNode, putContent, refusedInCell, selectPlaced, type Placed } from '@web/spaces/document/document-put';

/** The editor a drop is put by. */
type Editor = Parameters<typeof putContent>[0];

/**
 * Puts a drag within the body as its paste at the drop point.
 * @param editor - The editor.
 * @param view - The view.
 * @param event - The drop.
 * @param slice - The dragged content as ProseMirror hands it to `handleDrop`, read when the drag's own is not there.
 * @param moved - Whether the drop moves it, as ProseMirror reads the keys at the drop.
 * @returns True when the drop was handled here.
 * @throws {Error} What the placement threw, the dragged content given back first.
 */
export function dropAsPaste(editor: Editor, view: EditorView, event: DragEvent, slice: Slice, moved: boolean): boolean {
  const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
  if (at === undefined) return false;
  const { selection } = view.state;
  // What a move takes away is the dragged content: the selection, widened
  // over the tables at its ends when it reaches into a stored table.
  const stored = storedTableRange(selection);
  const ranges = stored === null ? selection.ranges.map(({ $from, $to }) => ({ from: $from.pos, to: $to.pos })) : [stored];
  if (!selection.empty && ranges.some(({ from, to }) => at >= from && at <= to)) return true;
  // A node drag carries the node selection it picked up (prosemirror-view
  // `Dragging.node`), which its public type leaves out; ProseMirror's own drop
  // deletes that, else the selection. With neither (the selection already
  // moved off the dragged content) nothing is taken away, and the drop lands
  // as the copy it then is.
  const node = (view.dragging as { node?: { replace: (tr: Transaction) => void } } | null)?.node;
  const removes = moved && (node !== undefined || !selection.empty);
  const tr = view.state.tr;
  if (removes && node !== undefined) node.replace(tr);
  else if (removes && !deleteStoredTableRange(selection, tr)) tr.deleteSelection();
  // The drag's own content as ProseMirror took it at dragstart, through the
  // copy transforms (`document-table-copy.ts`); the slice it hands over has
  // also been through the paste transforms against the selection the drag
  // began from. Its comments and row ids are settled here at the drop point.
  const dragged = view.dragging?.slice ?? slice;
  // A stored table, whole or left, is read as its copy is, as a table whose
  // cells hold blocks (temporary, with #1362's stored tables), before its
  // comments and row ids are settled, which the HTML would not carry.
  const parsed = holdsNode(dragged.content, 'table');
  const read = parsed ? readClipboardSlice(view.state.schema, view.serializeForClipboard(dragged).dom.innerHTML, '') : dragged;
  const content = withoutRowIdsIn(removes ? read : landingSlice(read, view, true), tr.doc);
  const { rows } = rowsOf(content);
  if (!holdsContent(rows, parsed)) return true;
  if (refusedInCell(cellAround(view.state.doc.resolve(at)) !== null, rows)) {
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
  /** Gives the dragged content back where the move took it from. */
  const giveBack = (): void => {
    const back = view.state.tr;
    for (let i = tr.steps.length - 1; i >= 0; i -= 1) back.step(tr.steps[i]!.invert(tr.docs[i]!));
    view.dispatch(back.setSelection(selection.getBookmark().resolve(back.doc)));
  };
  let placed: Placed | null;
  try {
    placed = landingAsDrop(removes, () =>
      putContent(editor, { source: { kind: 'slice', slice: content, parsed }, lost: 0, plain: null }, { wordsIntoTarget: true, judge: (props) => props, dropAt: point, byPaste: true, landed: true }),
    );
  } catch (error) {
    // The placement put the body back as the move left it; the move goes too.
    if (removes) giveBack();
    throw error;
  } finally {
    view.dragging = dragging;
  }
  // A move whose drop puts nothing gives the dragged content back, as
  // ProseMirror's own drop gives up when its insertion changes nothing.
  if (removes && view.state.doc.eq(taken)) {
    giveBack();
    return true;
  }
  if (placed !== null) selectPlaced(view, placed);
  return true;
}

