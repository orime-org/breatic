// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Dragging a table's row or column to another place in the table (inner#1126
 * A7).
 *
 * The drag is ours from start to drop. The library's own row drag rewrites the
 * whole table through its block JSON on drop, which leaves our comment marks
 * behind, and reads a table position that goes stale under someone else's
 * edit; it is never started, so its drop handling has nothing to act on.
 *
 * The cell the drag started on is held in plugin state and carried through
 * every change — the reader's own by mapping, a change through Yjs by the
 * element the cell is bound to (`document-table-cell-name.ts`) — so a row
 * someone else adds above it during the drag does not move a different row;
 * when that cell goes, the drag is given up. The drop
 * moves the row or column's own nodes with `moveTableRow` /
 * `moveTableColumn`, marks and all.
 */

import { createExtension } from '@blocknote/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

import type { BlockNoteEditor } from '@blocknote/core';

import { cellNamed, nameCell, type CellName } from '@web/spaces/document/document-table-cell-name';
import { cellAt, moveLineAt } from '@web/spaces/document/document-table-run';
import { fromYjs } from '@web/spaces/document/document-yjs-origin';

/** Which way a drag moves cells. */
export type DragOrientation = 'row' | 'column';

/** A drag in progress. */
interface Drag {
  /** The cell it started on, mapped through every change since. */
  readonly source: number;
  readonly orientation: DragOrientation;
  /** The gap the pointer is over: 0 before the first row or column. */
  readonly gap: number | null;
}

/** What a caller dispatches under the plugin's key. */
type DragCommand =
  | { readonly start: { readonly source: number; readonly orientation: DragOrientation } }
  | { readonly gap: number | null }
  | { readonly end: true };

/** Where the drag lives. */
const tableDragKey = new PluginKey<Drag | null>('document-table-drag');

/** The editor a drop writes to. */
type DropEditor = BlockNoteEditor<never, never, never>;

/**
 * Whether a row or column can be dragged from a cell: not where a merged cell
 * reaches across its edge.
 * @param doc - The document.
 * @param cellPos - The cell.
 * @param orientation - Its row or its column.
 * @returns True when it can.
 */
export function canDragFrom(doc: PMNode, cellPos: number, orientation: DragOrientation): boolean {
  const at = cellAt(doc, cellPos);
  if (at === null) return false;
  const rect =
    orientation === 'row'
      ? { left: 0, right: at.map.width, top: at.top, bottom: at.top + 1 }
      : { left: at.left, right: at.left + 1, top: 0, bottom: at.map.height };
  return at.map.cellsInRect(rect).every((rel) => {
    const cell = at.map.findCell(rel);
    return orientation === 'row'
      ? cell.top === rect.top && cell.bottom === rect.bottom
      : cell.left === rect.left && cell.right === rect.right;
  });
}

/**
 * The gap nearest a pointer, given the edges of the rows (or columns) in order.
 * @param edges - Each row's leading edge, then the last row's trailing edge.
 * @param pointer - The pointer, along the same axis.
 * @returns The gap: 0 before the first row, `edges.length - 1` after the last.
 */
export function dropGapAt(edges: readonly number[], pointer: number): number {
  let nearest = 0;
  edges.forEach((edge, index) => {
    if (Math.abs(edge - pointer) < Math.abs(edges[nearest]! - pointer)) nearest = index;
  });
  return nearest;
}

/**
 * Moves the row or column a cell is in to a gap.
 * @param editor - The editor to write to.
 * @param sourcePos - A cell of the row or column.
 * @param orientation - Row or column.
 * @param gap - Where it goes: 0 before the first.
 */
export function moveToGap(
  editor: DropEditor,
  sourcePos: number,
  orientation: DragOrientation,
  gap: number,
): void {
  const at = cellAt(editor.prosemirrorState.doc, sourcePos);
  if (at === null) return;
  const from = orientation === 'row' ? at.top : at.left;
  // The gap counts the line itself: a gap after it lands one index earlier.
  moveLineAt(editor, sourcePos, orientation, gap > from ? gap - 1 : gap);
}

/**
 * Starts a drag from a cell's row or column.
 * @param view - The editor view.
 * @param orientation - Row or column.
 * @param cellPos - The cell.
 * @returns Whether the drag started; not where a merged cell crosses it.
 */
export function startTableDrag(view: EditorView, orientation: DragOrientation, cellPos: number): boolean {
  if (!canDragFrom(view.state.doc, cellPos, orientation)) return false;
  const command: DragCommand = { start: { source: cellPos, orientation } };
  view.dispatch(view.state.tr.setMeta(tableDragKey, command).setMeta('addToHistory', false));
  return true;
}

/**
 * Ends the drag, dropped or not.
 * @param view - The editor view.
 */
export function endTableDrag(view: EditorView): void {
  if (tableDragKey.getState(view.state) == null || view.isDestroyed) return;
  const command: DragCommand = { end: true };
  view.dispatch(view.state.tr.setMeta(tableDragKey, command).setMeta('addToHistory', false));
}

/**
 * The drag in progress.
 * @param state - The editor state.
 * @returns Its source cell and orientation, or null.
 */
export function dragSourceOf(state: EditorState): { cellPos: number; orientation: DragOrientation } | null {
  const drag = tableDragKey.getState(state);
  return drag == null ? null : { cellPos: drag.source, orientation: drag.orientation };
}

/**
 * The edges of the rows or columns of the table a drag is in, on screen.
 * @param view - The editor view.
 * @param drag - The drag.
 * @returns The edges, or null when the table is not drawn.
 */
function edgesOf(view: EditorView, drag: Drag): number[] | null {
  const cell = view.nodeDOM(drag.source);
  const table = cell instanceof Element ? cell.closest('table') : null;
  if (table === null) return null;
  if (drag.orientation === 'row') {
    const rows = Array.from(table.querySelectorAll(':scope > tbody > tr, :scope > tr'));
    if (rows.length === 0) return null;
    const boxes = rows.map((row) => row.getBoundingClientRect());
    return [...boxes.map((box) => box.top), boxes[boxes.length - 1]!.bottom];
  }
  const at = cellAt(view.state.doc, drag.source);
  if (at === null) return null;
  // One cell per column, from the first row each column has a cell of its own in.
  const edges: number[] = [];
  let right = 0;
  for (let col = 0; col < at.map.width; col += 1) {
    const rel = at.map.map[col]!;
    const element = view.nodeDOM(at.tableStart + rel);
    if (!(element instanceof Element)) return null;
    const box = element.getBoundingClientRect();
    edges.push(box.left);
    right = box.right;
  }
  edges.push(right);
  return edges;
}

/**
 * The line drawn where a drop would land.
 * @param state - The editor state.
 * @returns Decorations on the row or the cells the line runs along.
 */
function dropLine(state: EditorState): DecorationSet {
  const drag = tableDragKey.getState(state);
  if (drag == null || drag.gap === null) return DecorationSet.empty;
  const at = cellAt(state.doc, drag.source);
  if (at === null) return DecorationSet.empty;
  const count = drag.orientation === 'row' ? at.map.height : at.map.width;
  const after = drag.gap === count;
  const index = after ? count - 1 : drag.gap;
  const rect =
    drag.orientation === 'row'
      ? { left: 0, right: at.map.width, top: index, bottom: index + 1 }
      : { left: index, right: index + 1, top: 0, bottom: at.map.height };
  const side = after ? 'after' : 'before';
  const decorations = at.map.cellsInRect(rect).map((rel) => {
    const pos = at.tableStart + rel;
    const cell = state.doc.nodeAt(pos)!;
    return Decoration.node(pos, pos + cell.nodeSize, {
      class: `doc-table-drop-${drag.orientation}-${side}`,
    });
  });
  return DecorationSet.create(state.doc, decorations);
}

/**
 * The plugin that holds the drag, draws where it would land, and drops it.
 * @param editor - The editor a drop writes to.
 * @returns The plugin.
 */
function tableDragPlugin(editor: DropEditor): Plugin<Drag | null> {
  // The source cell's Yjs element, as of the last change to the body.
  let named: CellName | null = null;
  return new Plugin<Drag | null>({
    key: tableDragKey,
    state: {
      init: (): Drag | null => null,
      apply: (tr, value, before): Drag | null => {
        const command = tr.getMeta(tableDragKey) as DragCommand | undefined;
        if (command !== undefined) {
          if ('end' in command) return null;
          if ('start' in command) return { ...command.start, gap: null };
          return value === null ? null : { ...value, gap: command.gap };
        }
        if (value === null || !tr.docChanged) return value;
        if (fromYjs(tr)) {
          const found = named === null ? null : cellNamed(before, tr.doc, named);
          return found === null ? null : { ...value, source: found };
        }
        const mapped = tr.mapping.mapResult(value.source, 1);
        // The cell the drag started on is gone: the drag has nothing to move.
        if (mapped.deleted || cellAt(tr.doc, mapped.pos) === null) return null;
        return { ...value, source: mapped.pos };
      },
    },
    // The handle a drag starts from can leave the page mid-drag (the
    // controller drops it), and a drag from an element no longer in the page
    // fires no `dragend`. So the end is also read off the page: any drop, any
    // drag end, and the first pointer move with no button held.
    view: (view) => {
      /** Ends the drag, if one is on. */
      const end = (): void => {
        endTableDrag(view);
      };
      /**
       * Ends the drag once the pointer moves with no button held.
       * @param event - The move.
       */
      const moved = (event: MouseEvent): void => {
        if (event.buttons === 0) end();
      };
      const page = view.dom.ownerDocument;
      page.addEventListener('dragend', end);
      page.addEventListener('drop', end);
      page.addEventListener('mousemove', moved);
      return {
        update: (current, prev): void => {
          const drag = tableDragKey.getState(current.state) ?? null;
          if (drag === null) {
            named = null;
          } else if (current.state.doc !== prev.doc || tableDragKey.getState(prev)?.source !== drag.source) {
            named = nameCell(current.state, drag.source);
          }
        },
        destroy: (): void => {
          page.removeEventListener('dragend', end);
          page.removeEventListener('drop', end);
          page.removeEventListener('mousemove', moved);
        },
      };
    },
    props: {
      decorations: dropLine,
      handleDOMEvents: {
        dragover: (view, event): boolean => {
          const drag = tableDragKey.getState(view.state);
          if (drag == null) return false;
          event.preventDefault();
          const edges = edgesOf(view, drag);
          if (edges === null) return true;
          const gap = dropGapAt(edges, drag.orientation === 'row' ? event.clientY : event.clientX);
          if (gap !== drag.gap) {
            const command: DragCommand = { gap };
            view.dispatch(view.state.tr.setMeta(tableDragKey, command).setMeta('addToHistory', false));
          }
          return true;
        },
        drop: (view, event): boolean => {
          const drag = tableDragKey.getState(view.state);
          if (drag == null) return false;
          event.preventDefault();
          if (drag.gap !== null) moveToGap(editor, drag.source, drag.orientation, drag.gap);
          endTableDrag(view);
          return true;
        },
      },
    },
  });
}

/**
 * The extension that carries the plugin.
 * @returns The extension, for the assembly to register.
 */
export const documentTableDragExtension = createExtension(({ editor }: { editor: unknown }) => ({
  key: 'document-table-drag',
  prosemirrorPlugins: [tableDragPlugin(editor as DropEditor)],
}) as never);
