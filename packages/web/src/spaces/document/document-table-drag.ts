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
import type { ComputeDropPositionContext } from '@blocknote/core/extensions';

import { followCell, renameCell, type CellName } from '@web/spaces/document/document-table-cell-name';
import { bodyScrollerOf, SCROLL_VIEWPORT } from '@web/spaces/document/document-body-autoscroll';
import { cellAt, moveLineAt } from '@web/spaces/document/document-table-run';

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
 * reaches across its edge. Every slot of the line is read off the table map,
 * the slots a merged cell from above or from the left covers too:
 * `cellsInRect` skips those, and a drop moves every row such a cell spans
 * (prosemirror-tables `getSelectionRangeInRow`), more than the line dragged.
 * @param doc - The document.
 * @param cellPos - The cell.
 * @param orientation - Its row or its column.
 * @returns True when it can.
 */
export function canDragFrom(doc: PMNode, cellPos: number, orientation: DragOrientation): boolean {
  const at = cellAt(doc, cellPos);
  if (at === null) return false;
  const { map } = at;
  const slots = orientation === 'row' ? map.width : map.height;
  for (let i = 0; i < slots; i += 1) {
    const index = orientation === 'row' ? at.top * map.width + i : i * map.width + at.left;
    const cell = map.findCell(map.map[index]!);
    const fits =
      orientation === 'row'
        ? cell.top === at.top && cell.bottom === at.top + 1
        : cell.left === at.left && cell.right === at.left + 1;
    if (!fits) return false;
  }
  return true;
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
  send(view, { start: { source: cellPos, orientation } });
  return true;
}

/**
 * Takes a row or column drag's drop line away, if one is drawn: the pointer
 * is over no part of the body scroller (the top bar, the Agent column), or
 * has left the page.
 * @param view - The editor view.
 */
export function clearTableDropLine(view: EditorView): void {
  if (tableDragKey.getState(view.state)?.gap != null) send(view, { gap: null });
}

/**
 * Ends the drag, dropped or not.
 * @param view - The editor view.
 */
export function endTableDrag(view: EditorView): void {
  if (tableDragKey.getState(view.state) == null || view.isDestroyed) return;
  send(view, { end: true });
}

/**
 * Hands the drag a command, outside the undo history.
 * @param view - The editor view.
 * @param command - The command.
 */
function send(view: EditorView, command: DragCommand): void {
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

/** The editor's drop-line hook (`dropCursor.hooks.computeDropPosition`). */
type DropPositionHook = (context: ComputeDropPositionContext) => ComputeDropPositionContext['defaultPosition'];

/**
 * Holds the editor's drop line back while a row or a column is dragged: that
 * drag draws its own line across the table, and the editor's line says where
 * words would land, which is not where the row or column goes. BlockNote's own
 * table handles hide it too, hiding the drop cursor's elements on each
 * dragover (`TableHandles.ts` `dragOverHandler`).
 * @param next - The hook for every other drag.
 * @returns The hook.
 */
export function holdDropLineInTableDrags(next: DropPositionHook): DropPositionHook {
  return (context) => (dragSourceOf(context.view.state) === null ? next(context) : null);
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
 * The frame a table scrolls sideways in.
 * @param view - The editor view.
 * @param cellPos - A cell of the table.
 * @returns The frame, or null when the cell is not drawn in one.
 */
export function tableFrameOf(view: EditorView, cellPos: number): HTMLElement | null {
  const cell = view.nodeDOM(cellPos);
  return cell instanceof Element ? cell.closest<HTMLElement>(SCROLL_VIEWPORT) : null;
}

/**
 * Where on screen a drag's lines can be seen, along the axis they move on: a
 * column's within its table frame, a row's within the body scroller. Past it
 * the edges the table lays out are clipped from view.
 * @param view - The editor view.
 * @param drag - The drag.
 * @returns The start and end, or null when nothing clips them.
 */
function shownRange(view: EditorView, drag: Drag): [number, number] | null {
  const clip = drag.orientation === 'column' ? tableFrameOf(view, drag.source) : bodyScrollerOf(view);
  if (clip === null) return null;
  const box = clip.getBoundingClientRect();
  return drag.orientation === 'row' ? [box.top, box.bottom] : [box.left, box.right];
}

/**
 * The gap the pointer of a drag event is over, among the edges the reader
 * sees. The line is drawn at this gap and a drop lands at it, so with no edge
 * shown — the table scrolled out of view, a column wider than its frame —
 * there is neither.
 * @param view - The editor view.
 * @param drag - The drag.
 * @param event - The dragover or drop.
 * @returns The gap, or null when no edge is shown or the table is not drawn.
 */
function gapUnder(view: EditorView, drag: Drag, event: MouseEvent): number | null {
  const edges = edgesOf(view, drag);
  if (edges === null) return null;
  const pointer = drag.orientation === 'row' ? event.clientY : event.clientX;
  const [start, end] = shownRange(view, drag) ?? [-Infinity, Infinity];
  // A pixel either way: a table flush with its frame has its outer edges on
  // the frame's own, at fractional positions.
  const gaps = edges.flatMap((edge, gap) => (edge >= start - 1 && edge <= end + 1 ? [gap] : []));
  return gaps.length === 0 ? null : gaps[dropGapAt(gaps.map((gap) => edges[gap]!), pointer)]!;
}

/**
 * Whether a drag event is inside the body scroller — over the text column or
 * the gutters beside it, the area a table drag can land in — or, for an editor
 * in no scroller, inside the editor.
 * @param view - The editor view.
 * @param target - The event's target.
 * @returns Whether it is.
 */
function inBody(view: EditorView, target: EventTarget | null): boolean {
  return target instanceof Node && (bodyScrollerOf(view) ?? view.dom).contains(target);
}

/**
 * Takes a dragover: the line is drawn at the gap under the pointer, or goes
 * when no shown edge is there.
 * @param view - The editor view.
 * @param drag - The drag.
 * @param event - The dragover.
 */
function trackGap(view: EditorView, drag: Drag, event: DragEvent): void {
  event.preventDefault();
  const gap = gapUnder(view, drag, event);
  if (gap !== drag.gap) send(view, { gap });
}

/**
 * Takes a drop: the dragged row or column moves to the gap under the pointer;
 * with no gap there, nothing moves.
 * @param editor - The editor to write to.
 * @param view - The editor view.
 * @param drag - The drag.
 * @param event - The drop.
 */
function dropAtGap(editor: DropEditor, view: EditorView, drag: Drag, event: DragEvent): void {
  event.preventDefault();
  // Read at the drop itself: the body or the table frame can scroll the lines
  // under a still pointer between dragovers (inner#1350).
  const gap = gapUnder(view, drag, event);
  if (gap !== null) moveToGap(editor, drag.source, drag.orientation, gap);
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
        const source = followCell(tr, before, value.source, named);
        // The cell the drag started on is gone: the drag has nothing to move.
        return source === null ? null : { ...value, source };
      },
    },
    // The drag is taken off the page, in the capture phase: over the gutters
    // beside the text column the editor sees nothing, and over a block's own
    // controls it lets the event go (a node view's `stopEvent`). Cancelled there,
    // the editor leaves the event alone (`prosemirror-view` `eventBelongsToView`).
    // The handle a drag starts from can leave the page mid-drag (its table can
    // be deleted under it), and a drag from an element no longer in the page
    // fires no `dragend`: the end is also read off any drop, any drag end, and
    // the first pointer move with no button held.
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
      /**
       * Takes a dragover, or the dragenter a browser fires in its place on the
       * update the element under the pointer changes: inside the body scroller
       * the line follows the pointer; over the top bar or the Agent column it
       * goes, as the editor's own drop cursor does when the pointer leaves it.
       * @param event - The dragover or dragenter.
       */
      const over = (event: DragEvent): void => {
        const drag = tableDragKey.getState(view.state);
        if (drag == null) return;
        if (inBody(view, event.target)) trackGap(view, drag, event);
        else clearTableDropLine(view);
      };
      /**
       * Takes a drop inside the body scroller; any other drop only ends the drag.
       * @param event - The drop.
       */
      const dropped = (event: DragEvent): void => {
        const drag = tableDragKey.getState(view.state);
        if (drag != null && inBody(view, event.target)) dropAtGap(editor, view, drag, event);
        end();
      };
      page.addEventListener('dragend', end);
      page.addEventListener('dragenter', over, true);
      page.addEventListener('dragover', over, true);
      page.addEventListener('drop', dropped, true);
      page.addEventListener('mousemove', moved);
      return {
        update: (current, prev): void => {
          const source = tableDragKey.getState(current.state)?.source ?? null;
          named = renameCell(current.state, prev, source, tableDragKey.getState(prev)?.source ?? null, named);
        },
        destroy: (): void => {
          page.removeEventListener('dragend', end);
          page.removeEventListener('dragenter', over, true);
          page.removeEventListener('dragover', over, true);
          page.removeEventListener('drop', dropped, true);
          page.removeEventListener('mousemove', moved);
        },
      };
    },
    props: {
      decorations: dropLine,
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
