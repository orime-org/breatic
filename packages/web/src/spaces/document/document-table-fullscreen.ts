// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A table opened full screen (breatic#1427, design §5.3-§5.4).
 *
 * The editor area covers the window and shows this one table; the rest of the
 * body is still in the same editor, hidden. This plugin is what keeps the user
 * inside the table while that is so: the caret, every local write, drops and
 * Escape. It is registered with the editor and stays for the editor's life —
 * changing the plugin set rebuilds every plugin view, and the undo plugin's
 * view destroys the body's undo manager on the way (`document-editor-cache.ts`
 * header). Its state is null-shaped until a table opens.
 *
 * Every change of state is written by `apply`, in the transaction that causes
 * it, so a hidden Space (whose effects wait) still finds where to return.
 */

import { createExtension } from '@blocknote/core';
import { SuggestionMenu } from '@blocknote/core/extensions';
import type { Node as PMNode } from '@tiptap/pm/model';
import {
  AllSelection,
  Plugin,
  PluginKey,
  Selection,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import { CellSelection, TableMap } from '@tiptap/pm/tables';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

import { isFreeEscape } from '@web/spaces/canvas/use-escape-in-space';
import { aiRangeIn } from '@web/spaces/document/document-ai-range';
import { documentBarsOf } from '@web/spaces/document/document-bars';
import { bodyScrollerOf } from '@web/spaces/document/document-body-autoscroll';
import { PASTED_MEDIA_KEY } from '@web/spaces/document/document-external-media';
import { watchPluginState } from '@web/spaces/document/document-plugin-watch';
import { cellDepthOf, DOC_TABLE, tableAround, type TableAt } from '@web/spaces/document/document-table-nodes';
import { blockById } from '@web/spaces/document/document-proposal-landing';
import { compositionEnd, type CompositionEnd } from '@web/lib/composition-end';
import { fromYjs, undoRedo } from '@web/spaces/document/document-yjs-origin';

/** Where the body goes back to once full screen has ended. */
export type FullscreenReturn =
  | { readonly kind: 'table'; readonly id: string; readonly offset: number }
  | { readonly kind: 'scrollTop'; readonly value: number }
  | { readonly kind: 'selection' };

/** Full screen as the plugin keeps it. */
export type TableFullscreen =
  | { readonly table: string; readonly scrollTop: number; readonly offset: number }
  | { readonly table: null; readonly returnTo: FullscreenReturn | null };

/** An entry into full screen. */
export interface FullscreenEntry {
  /** The table's block id. */
  readonly table: string;
  /** The body scroller's `scrollTop` at entry. */
  readonly scrollTop: number;
  /** How far the table's top stood below the scroller's top at entry. */
  readonly offset: number;
}

/** What `setTableFullscreen` and `clearFullscreenReturn` ask of the plugin. */
type FullscreenCommand =
  | { readonly kind: 'enter'; readonly entry: FullscreenEntry }
  | { readonly kind: 'exit' }
  | { readonly kind: 'cleared' };

/** The editor these functions are handed: anything holding a view. */
interface FullscreenEditor {
  readonly prosemirrorView: EditorView | null | undefined;
}

/** The BlockNote editor, as far as the layers that keep Escape are asked of it. */
interface ExtensionEditor {
  readonly getExtension: (ext: unknown) => unknown;
}

const DOCUMENT_TABLE_FULLSCREEN = new PluginKey<TableFullscreen>('document-table-fullscreen');

/** Not in full screen, nothing to return to. One object, so `===` holds. */
const BODY: TableFullscreen = { table: null, returnTo: null };

/**
 * Full screen in this state.
 * @param state - The editor state.
 * @returns The full-screen state.
 */
export function tableFullscreenIn(state: EditorState): TableFullscreen {
  return DOCUMENT_TABLE_FULLSCREEN.getState(state) ?? BODY;
}

/**
 * Whether a table is open full screen in this state.
 * @param state - The editor state.
 * @returns True while one is.
 */
export function inTableFullscreen(state: EditorState): boolean {
  return tableFullscreenIn(state).table !== null;
}

/**
 * The open table, as long as it still has a cell to stand in. A table left
 * with only empty rows (two people deleting its last two columns at once)
 * counts as gone: full screen has nothing left to edit.
 * @param doc - The document.
 * @param id - The table's block id.
 * @returns Its position and node, or null.
 */
function tableById(doc: PMNode, id: string): TableAt | null {
  const block = blockById(doc, id);
  if (block === null || block.node.type.name !== DOC_TABLE) return null;
  return TableMap.get(block.node).map.length > 0 ? block : null;
}

/**
 * The positions before a table's top-left and bottom-right grid cells. Read
 * off the grid: in document order the last cell need not be in the last
 * column when a cell merged down covers it.
 * @param table - The table.
 * @returns The two positions.
 */
function cornersOf(table: TableAt): { first: number; last: number } {
  const { map } = TableMap.get(table.node);
  return { first: table.pos + 1 + map[0]!, last: table.pos + 1 + map[map.length - 1]! };
}

/**
 * Whether a position sits in one of a table's cells.
 * @param doc - The document.
 * @param pos - The position.
 * @param table - The table.
 * @returns True inside a cell of that table.
 */
function inCellOf(doc: PMNode, pos: number, table: TableAt): boolean {
  const $pos = doc.resolve(pos);
  return tableAround($pos)?.pos === table.pos && cellDepthOf($pos) > 0;
}

/**
 * Whether a selection lies wholly in a table's cells.
 * @param selection - The selection.
 * @param table - The table.
 * @returns True when both its ends are in that table's cells.
 */
function selectionIn(selection: Selection, table: TableAt): boolean {
  if (selection instanceof CellSelection) {
    return selection.$anchorCell.pos > table.pos && selection.$headCell.pos < table.pos + table.node.nodeSize;
  }
  const doc = selection.$anchor.doc;
  return inCellOf(doc, selection.anchor, table) && inCellOf(doc, selection.head, table);
}

/**
 * The caret at the start of a table's first cell.
 * @param doc - The document.
 * @param table - The table.
 * @returns The selection.
 */
function startOf(doc: PMNode, table: TableAt): Selection {
  return Selection.near(doc.resolve(cornersOf(table).first + 1));
}

/**
 * The span a transaction changed, in the document before it.
 * @param before - The document before.
 * @param after - The document after.
 * @returns The span, or null when nothing changed.
 */
function changedSpan(before: PMNode, after: PMNode): { from: number; to: number } | null {
  const from = before.content.findDiffStart(after.content);
  if (from === null) return null;
  const end = before.content.findDiffEnd(after.content);
  return { from, to: end === null ? before.content.size : Math.max(end.a, from) };
}

/**
 * Whether a change stays within a table, the table's own edges included.
 * @param span - The changed span, in the document before.
 * @param span.from - Where it starts.
 * @param span.to - Where it ends.
 * @param table - The table there.
 * @returns True when the change touches nothing outside it.
 */
function spanWithin(span: { from: number; to: number }, table: TableAt): boolean {
  return span.from >= table.pos && span.to <= table.pos + table.node.nodeSize;
}

/**
 * Opens a table full screen, or ends full screen.
 *
 * Opening also puts a caret that stands outside the table at the start of its
 * first cell, in the same transaction.
 * @param editor - The editor.
 * @param entry - The table and where the body was scrolled, or null to end it.
 */
export function setTableFullscreen(editor: FullscreenEditor, entry: FullscreenEntry | null): void {
  const view = editor.prosemirrorView;
  if (view === null || view === undefined) return;
  const { state } = view;
  if (entry === null) {
    if (!inTableFullscreen(state)) return;
    view.dispatch(state.tr.setMeta(DOCUMENT_TABLE_FULLSCREEN, { kind: 'exit' } satisfies FullscreenCommand));
    return;
  }
  const table = tableById(state.doc, entry.table);
  if (table === null) return;
  const tr = state.tr.setMeta(DOCUMENT_TABLE_FULLSCREEN, { kind: 'enter', entry } satisfies FullscreenCommand);
  if (!selectionIn(state.selection, table)) tr.setSelection(startOf(state.doc, table));
  view.dispatch(tr);
}

/**
 * Ends full screen before a write that lands outside one of the open table's
 * cells, so the user sees what it writes (design §5.3): an AI result aimed at
 * the whole table or past it, a proposal from the Agent.
 * @param editor - The editor.
 * @param target - The span the write replaces or follows.
 * @param target.from - Where it starts.
 * @param target.to - Where it ends.
 */
export function leaveFullscreenForWrite(editor: FullscreenEditor, target: { from: number; to: number }): void {
  const view = editor.prosemirrorView;
  if (view === null || view === undefined) return;
  const now = tableFullscreenIn(view.state);
  if (now.table === null) return;
  const doc = view.state.doc;
  const table = tableById(doc, now.table);
  const $from = doc.resolve(target.from);
  const cell = cellDepthOf($from);
  const sameCell = table !== null && inCellOf(doc, target.from, table) && inCellOf(doc, target.to, table)
    && $from.sharedDepth(target.to) >= cell;
  if (!sameCell) setTableFullscreen(editor, null);
}

/**
 * Opens a table full screen from where it stands in the body, recording how
 * far the body was scrolled and how far the table stood below the top.
 * @param editor - The editor.
 * @param tableId - The table's block id.
 */
export function openTableFullscreen(editor: FullscreenEditor, tableId: string): void {
  const view = editor.prosemirrorView;
  if (view === null || view === undefined) return;
  const table = tableById(view.state.doc, tableId);
  if (table === null) return;
  const scroller = bodyScrollerOf(view);
  const element = view.nodeDOM(table.pos);
  const top = element instanceof HTMLElement ? element.getBoundingClientRect().top : 0;
  const scrollerTop = scroller?.getBoundingClientRect().top ?? 0;
  setTableFullscreen(editor, { table: tableId, scrollTop: scroller?.scrollTop ?? 0, offset: top - scrollerTop });
}

/**
 * Forgets where to return, once the shell has scrolled there.
 * @param editor - The editor.
 */
export function clearFullscreenReturn(editor: FullscreenEditor): void {
  const view = editor.prosemirrorView;
  if (view === null || view === undefined) return;
  const now = tableFullscreenIn(view.state);
  if (now.table !== null || now.returnTo === null) return;
  view.dispatch(view.state.tr.setMeta(DOCUMENT_TABLE_FULLSCREEN, { kind: 'cleared' } satisfies FullscreenCommand));
}

/** Tells React when full screen changes. */
export const tableFullscreenWatch = watchPluginState(tableFullscreenIn);

/**
 * The next full-screen state after a transaction.
 * @param tr - The transaction.
 * @param current - The state before it.
 * @param before - The editor state it applies to.
 * @returns The state after it; `current` itself when nothing changed.
 */
function next(tr: Transaction, current: TableFullscreen, before: EditorState): TableFullscreen {
  const asked = tr.getMeta(DOCUMENT_TABLE_FULLSCREEN) as FullscreenCommand | undefined;
  if (asked?.kind === 'enter') return { ...asked.entry };
  if (asked?.kind === 'cleared') return BODY;
  if (current.table === null) return current;
  if (asked?.kind === 'exit') {
    return { table: null, returnTo: { kind: 'table', id: current.table, offset: current.offset } };
  }
  if (!tr.docChanged) return current;
  if (tableById(tr.doc, current.table) === null) {
    return { table: null, returnTo: { kind: 'scrollTop', value: current.scrollTop } };
  }
  if (undoRedo(tr)) {
    const span = changedSpan(before.doc, tr.doc);
    const table = tableById(before.doc, current.table);
    if (span !== null && (table === null || !spanWithin(span, table))) {
      return { table: null, returnTo: { kind: 'selection' } };
    }
  }
  return current;
}

/**
 * Whether a local transaction may go through in full screen.
 * @param tr - The transaction.
 * @param state - The state it applies to.
 * @returns False for one that writes outside the open table while it stays.
 */
function allowed(tr: Transaction, state: EditorState): boolean {
  const now = tableFullscreenIn(state);
  if (now.table === null || !tr.docChanged || fromYjs(tr)) return true;
  // The table gone is the table deleted (every row, every column, or the
  // whole of it replaced) — `apply` ends full screen in the same step.
  if (tableById(tr.doc, now.table) === null) return true;
  const table = tableById(state.doc, now.table);
  const span = changedSpan(state.doc, tr.doc);
  return table === null || span === null || spanWithin(span, table);
}

/**
 * The selection a full-screen table needs after these transactions, if any.
 * @param transactions - The transactions just applied.
 * @param before - The state before them.
 * @param after - The state after them.
 * @returns A transaction putting the selection back in the table, or null.
 */
function keepSelectionIn(transactions: readonly Transaction[], before: EditorState, after: EditorState): Transaction | null {
  const now = tableFullscreenIn(after);
  if (now.table === null) return null;
  const table = tableById(after.doc, now.table);
  if (table === null) return null;
  const { selection } = after;
  if (selection instanceof AllSelection) {
    const { first, last } = cornersOf(table);
    return after.tr.setSelection(CellSelection.create(after.doc, first, last));
  }
  if (selectionIn(selection, table)) return null;
  const local = !transactions.some(fromYjs);
  const wasIn = tableFullscreenIn(before).table === now.table && (() => {
    const old = tableById(before.doc, now.table);
    return old !== null && selectionIn(before.selection, old);
  })();
  if (local && wasIn) {
    let bookmark = before.selection.getBookmark();
    transactions.forEach((tr) => {
      bookmark = bookmark.map(tr.mapping);
    });
    const mapped = bookmark.resolve(after.doc);
    if (selectionIn(mapped, table)) return after.tr.setSelection(mapped);
  }
  return after.tr.setSelection(startOf(after.doc, table));
}

/**
 * Ends full screen on an Escape nobody else answered, typed in a cell.
 *
 * `isFreeEscape` leaves an Escape an input method or a layer above already
 * took; `ended` leaves the one Chrome sends again right after a composition
 * ends, which ProseMirror's own composition guard lets through outside Safari
 * (see `document-enter.ts`).
 * @param editor - The BlockNote editor, for the layers that keep the key.
 * @param ended - This editor's composition ends.
 * @param view - The view.
 * @param event - The keydown.
 * @returns True when it ended full screen.
 */
function escapeOut(editor: ExtensionEditor, ended: CompositionEnd, view: EditorView, event: KeyboardEvent): boolean {
  if (!inTableFullscreen(view.state) || !isFreeEscape(event) || ended.justEnded()) return false;
  if (aiRangeIn(view.state) !== null) return false;
  if ((editor.getExtension(SuggestionMenu) as { shown?: () => boolean } | undefined)?.shown?.() === true) return false;
  if (documentBarsOf(editor).linkToolbarUp) return false;
  event.preventDefault();
  view.dispatch(view.state.tr.setMeta(DOCUMENT_TABLE_FULLSCREEN, { kind: 'exit' } satisfies FullscreenCommand));
  return true;
}

/**
 * Takes every drag that reaches the body while a table is full screen: files,
 * content from another app, blocks and words. A table's own row and column
 * drags are page listeners in the capture phase and run before this.
 * @param view - The view.
 * @param event - The dragover or drop.
 * @returns True while full screen, having taken the event.
 */
function takeDrag(view: EditorView, event: Event): boolean {
  if (!inTableFullscreen(view.state)) return false;
  const transfer = (event as DragEvent).dataTransfer;
  if (transfer) transfer.dropEffect = 'none';
  event.preventDefault();
  return true;
}

/**
 * The extension holding the full-screen plugin. It runs ahead of the drop,
 * key and edge handlers it has to answer before.
 * @returns The extension, for the assembly to register.
 */
export const documentTableFullscreenExtension = createExtension(({ editor }: { readonly editor: ExtensionEditor }) => {
  const ended = compositionEnd();
  return {
    key: 'document-table-fullscreen',
    runsBefore: [
      'documentFileDrop',
      PASTED_MEDIA_KEY,
      'document-drag-drop',
      'document-table-keys',
      'document-keyboard-move',
      'document-body-edge-pointer',
      'document-ai-range',
    ],
    prosemirrorPlugins: [
      new Plugin<TableFullscreen>({
        key: DOCUMENT_TABLE_FULLSCREEN,
        state: {
        /**
         * Starts in the body.
         * @returns The body state.
         */
          init: (): TableFullscreen => BODY,
          apply: next,
        },
        filterTransaction: allowed,
        appendTransaction: keepSelectionIn,
        view: tableFullscreenWatch.view,
        props: {
        /**
         * Marks the open table, which is what the stylesheet shows.
         * @param state - The editor state.
         * @returns The mark, or none.
         */
          decorations: (state): DecorationSet | null => {
            const now = tableFullscreenIn(state);
            if (now.table === null) return null;
            const table = tableById(state.doc, now.table);
            if (table === null) return null;
            return DecorationSet.create(state.doc, [
              Decoration.node(table.pos, table.pos + table.node.nodeSize, { 'data-fullscreen-table': '' }),
            ]);
          },
          handleKeyDown: (view, event): boolean => event.key === 'Escape' && escapeOut(editor, ended, view, event),
          handleDOMEvents: {
            dragover: takeDrag,
            drop: takeDrag,
            compositionend: (): boolean => {
              ended.mark();
              return false;
            },
          },
        },
      }),
    ],
  };
});
