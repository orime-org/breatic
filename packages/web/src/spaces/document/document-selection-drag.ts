// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The preview of a drag of what is selected (inner#1350 A1, design §4).
 *
 * ProseMirror hands a selection drag no image of its own, and the browser's
 * is the selection at its full size, cut to the window. So a drag of selected
 * content gets the preview every other drag gets: the whole blocks the
 * selection touches, drawn through the same exit as a row drag
 * (`blockPreviewContent`, `buildDragPreview`), scaled down when a side is
 * longer than 512px and anchored at its top left. A cell selection draws every column of the rows its cells are
 * in; a drag of a caption field's words draws the whole field. Editors that
 * draw their own drag previews draw whole blocks (Tiptap's drag handle,
 * BlockNote's multi-block drag, Plate, CKEditor 5).
 *
 * Which drag this is, in order: a press in a caption field is that field's,
 * whatever is selected — opening the caption selects the media block; a row
 * drag (a handle's or a medium's) and a table line drag draw their own; and
 * otherwise it is a drag of the selection by ProseMirror's own test: a
 * selection that is not empty, pressed inside (`prosemirror-view`
 * `handlers.dragstart`).
 */

import { createExtension } from '@blocknote/core';
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { CellSelection, TableMap } from '@tiptap/pm/tables';
import type { EditorView } from '@tiptap/pm/view';

import { MEDIA_CAPTION_INPUT } from '@web/spaces/document/DocumentMediaBlock';
import { rowInFlight } from '@web/spaces/document/document-drag-drop';
import {
  blockPreviewContent,
  captionPreviewContent,
  type PlacedContent,
  setDragPreview,
  tableRowsPreviewContent,
} from '@web/spaces/document/document-drag-preview';
import { dragSourceOf } from '@web/spaces/document/document-table-drag';
import { holdsBlocks } from '@web/spaces/document/document-table-nodes';

/** A drag this module draws the preview of. */
export type SelectionDragKind = 'caption' | 'selection';

/**
 * Which drag a dragstart in the body is, of the two this module draws.
 * @param view - The editor view.
 * @param event - The dragstart.
 * @param event.target - What it started on.
 * @param pressAt - The document position under the press, if any.
 * @returns The kind, or null when the drag draws its own preview or none.
 */
export function selectionDragKind(
  view: EditorView,
  event: { target: EventTarget | null },
  pressAt: number | null,
): SelectionDragKind | null {
  if (event.target instanceof Element && event.target.closest(MEDIA_CAPTION_INPUT) !== null) return 'caption';
  if (rowInFlight() || dragSourceOf(view.state) !== null) return null;
  const { selection } = view.state;
  if (selection.empty || pressAt === null) return null;
  const end = selection instanceof NodeSelection ? selection.to - 1 : selection.to;
  return pressAt >= selection.from && pressAt <= end ? 'selection' : null;
}

/**
 * The positions of the blocks a range touches: those of the block group (or
 * the table cell) that holds both its ends, from the block one end is in to the block the other is
 * in. The ends are first brought inside the body's own block group, which a
 * whole-body selection's ends are outside of.
 * @param doc - The document.
 * @param from - The range's start.
 * @param to - Its end.
 * @returns The blocks' positions, in order.
 */
function touchedBlocks(doc: PMNode, from: number, to: number): number[] {
  /**
   * Brings a position inside the body's block group.
   * @param pos - The position.
   * @returns It, or the group's nearest end.
   */
  const inside = (pos: number): number => Math.min(Math.max(pos, 1), doc.content.size - 1);
  const $from = doc.resolve(inside(from));
  const $to = doc.resolve(inside(to));
  let depth = $from.sharedDepth($to.pos);
  // A table cell holds blocks the way a group does: a range in one cell
  // touches that cell's blocks.
  while (depth > 0 && !holdsBlocks($from.node(depth))) depth -= 1;
  const group = $from.node(depth);
  if (group.childCount === 0) return [];
  const first = Math.min($from.index(depth), group.childCount - 1);
  // A position between two blocks of the group belongs to the block before it.
  const last = Math.min($to.depth === depth ? $to.index(depth) - 1 : $to.index(depth), group.childCount - 1);
  const blocks: number[] = [];
  for (let index = first; index <= Math.max(first, last); index += 1) blocks.push($from.posAtIndex(index, depth));
  return blocks;
}

/**
 * What the preview of a drag of the selection shows: the whole blocks the
 * selection touches, each with the blocks nested under it, or every column of
 * the rows a cell selection's cells are in.
 * @param view - The editor view.
 * @returns The content, detached; null when there is nothing to draw.
 */
export function selectionPreviewContent(view: EditorView): PlacedContent | null {
  const { selection, doc } = view.state;
  if (selection instanceof CellSelection) {
    const table = selection.$anchorCell.node(-1);
    const start = selection.$anchorCell.start(-1);
    const rect = TableMap.get(table).rectBetween(selection.$anchorCell.pos - start, selection.$headCell.pos - start);
    return tableRowsPreviewContent(view, selection.$anchorCell.pos, rect.top, rect.bottom);
  }
  const copies = touchedBlocks(doc, selection.from, selection.to)
    .map((pos) => view.nodeDOM(pos))
    .filter((node): node is Element => node instanceof Element)
    .map((block) => block.cloneNode(true) as Element);
  return copies.length === 0 ? null : blockPreviewContent(view, copies);
}

/**
 * Hands the browser the preview of a drag of the selection or of a caption
 * field's words; the preview takes itself off the page once the browser has
 * the image (`buildDragPreview`).
 * @param view - The editor view.
 * @param event - The dragstart.
 */
function previewSelectionDrag(view: EditorView, event: DragEvent): void {
  const { dataTransfer, target } = event;
  if (event.defaultPrevented || !dataTransfer || !(target instanceof Node) || !view.dom.contains(target)) return;
  const pressAt = view.state.selection.empty ? null : (view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null);
  const kind = selectionDragKind(view, event, pressAt);
  if (kind === null) return;
  const caption = kind === 'caption' ? (target as Element).closest<HTMLInputElement>(MEDIA_CAPTION_INPUT) : null;
  const content = caption !== null ? captionPreviewContent(caption) : selectionPreviewContent(view);
  if (content === null) return;
  setDragPreview(view, dataTransfer, content);
}

/**
 * The extension that draws the preview of a drag of what is selected. It
 * listens on the page, so it hears a dragstart after the handlers that start
 * a row drag or a table line drag have run.
 * @returns The extension, for the assembly to register.
 */
export const documentSelectionDragExtension = createExtension(() => ({
  key: 'document-selection-drag',
  prosemirrorPlugins: [
    new Plugin({
      key: new PluginKey('documentSelectionDrag'),
      view: (view) => {
        const page = view.dom.ownerDocument;
        /**
         * Draws the preview when the drag is one of the two.
         * @param event - The dragstart.
         */
        const onDragStart = (event: DragEvent): void => {
          previewSelectionDrag(view, event);
        };
        page.addEventListener('dragstart', onDragStart);
        return {
          destroy: () => {
            page.removeEventListener('dragstart', onDragStart);
          },
        };
      },
    }),
  ],
}));
