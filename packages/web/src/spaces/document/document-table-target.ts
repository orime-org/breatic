// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The cell a table menu was opened on.
 *
 * A menu stays open while the document changes under it — a collaborator
 * typing above the table, adding a row, deleting one — so the cell is held as
 * a position in plugin state and carried through every transaction: the
 * user's own edits by mapping, the way ProseMirror maps decorations, and
 * changes that come in through Yjs by the element the cell is bound to
 * (`document-table-cell-name.ts`). When the cell itself is deleted the target
 * is cleared, and the menu has nothing left to act on. The plugin's `apply` is
 * the one place the target changes; a menu sets and clears it with a meta.
 *
 * A menu also names the cells it acts on (its row, its column, or the cell
 * button's one cell), and the plugin marks them while the menu is open, in the
 * look of selected cells, so the user sees what the commands will reach (the confirmed demo's flow, step
 * five). The user's own selection is left as it was.
 *
 * A command that waits on the clipboard (a paste, a cut that falls back to the
 * async clipboard) holds its own cell the same way until it is done
 * (`holdPendingCell`): the menu's target is cleared when the menu closes, and
 * another table menu may open meanwhile.
 */

import { createExtension } from '@blocknote/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

import { followCell, renameCell, type CellName } from '@web/spaces/document/document-table-cell-name';
import { cellsOfScope, type CellScope } from '@web/spaces/document/document-table-run';

/** The target cell, and the cells its menu acts on: its row, its column or itself. */
interface Held {
  readonly pos: number;
  readonly line: CellScope;
}

/** What a menu holds, or null when no menu holds a cell. */
type Target = Held | null;

/** The class on each cell the open menu acts on. */
const TARGET_CLASS = 'doc-table-target';

/** Where the target lives. */
const tableTargetKey = new PluginKey<Target>('document-table-target');

/**
 * The plugin that holds and maps the target.
 * @returns The plugin.
 */
function tableTargetPlugin(): Plugin<Target> {
  // The target's Yjs element, as of the last change to the body.
  let named: CellName | null = null;
  return new Plugin<Target>({
    key: tableTargetKey,
    state: {
      init: (): Target => null,
      apply: (tr, value, before): Target => {
        const set = tr.getMeta(tableTargetKey) as Target | undefined;
        if (set !== undefined) return set;
        if (value === null || !tr.docChanged) return value;
        const pos = followCell(tr, before, value.pos, named);
        return pos === null ? null : { pos, line: value.line };
      },
    },
    view: () => ({
      update: (view, prev): void => {
        named = renameCell(view.state, prev, tableTargetOf(view.state), tableTargetOf(prev), named);
      },
    }),
    props: {
      /**
       * Marks the cells the open menu acts on.
       * @param state - The editor state.
       * @returns The marks, or none.
       */
      decorations: (state): DecorationSet | null => {
        const held = tableTargetKey.getState(state) ?? null;
        if (held === null) return null;
        const marks = cellsOfScope(state.doc, held.pos, held.line).map((pos) =>
          Decoration.node(pos, pos + (state.doc.nodeAt(pos)?.nodeSize ?? 0), { class: TARGET_CLASS }),
        );
        return DecorationSet.create(state.doc, marks);
      },
    },
  });
}

/**
 * The cell a table menu holds.
 * @param state - The editor state.
 * @returns The position before the cell, or null.
 */
export function tableTargetOf(state: EditorState): number | null {
  return tableTargetKey.getState(state)?.pos ?? null;
}

/**
 * Sets or clears the cell a table menu acts on.
 * @param view - The editor view.
 * @param pos - The position before the cell, or null to clear it.
 * @param line - The cells its menu acts on: the row, the column or the one cell.
 */
export function setTableTarget(view: EditorView, pos: number | null, line: CellScope = 'cell'): void {
  const held: Target = pos === null ? null : { pos, line };
  view.dispatch(view.state.tr.setMeta(tableTargetKey, held).setMeta('addToHistory', false));
}

/** The cells commands waiting on the clipboard hold, by the hold's key. */
type Pending = ReadonlyMap<symbol, number>;

/** Adds or drops one held cell. */
type PendingMeta = { readonly add: symbol; readonly pos: number } | { readonly drop: symbol };

/** Where the cells waiting commands hold live. */
const pendingKey = new PluginKey<Pending>('document-table-pending');

/**
 * The plugin that holds and maps the cells of commands waiting on the clipboard.
 * @returns The plugin.
 */
function pendingCellsPlugin(): Plugin<Pending> {
  // Each held cell's Yjs element, as of the last change to the body.
  const named = new Map<symbol, CellName | null>();
  return new Plugin<Pending>({
    key: pendingKey,
    state: {
      init: (): Pending => new Map(),
      apply: (tr, value, before): Pending => {
        const meta = tr.getMeta(pendingKey) as PendingMeta | undefined;
        const next = new Map(value);
        if (tr.docChanged) {
          for (const [key, pos] of value) {
            const moved = followCell(tr, before, pos, named.get(key) ?? null);
            if (moved === null) next.delete(key);
            else next.set(key, moved);
          }
        }
        if (meta !== undefined && 'add' in meta) next.set(meta.add, meta.pos);
        if (meta !== undefined && 'drop' in meta) next.delete(meta.drop);
        return meta === undefined && !tr.docChanged ? value : next;
      },
    },
    view: () => ({
      update: (view, prev): void => {
        const now = pendingKey.getState(view.state) ?? new Map<symbol, number>();
        const was = pendingKey.getState(prev) ?? new Map<symbol, number>();
        for (const key of named.keys()) if (!now.has(key)) named.delete(key);
        for (const [key, pos] of now) {
          named.set(key, renameCell(view.state, prev, pos, was.get(key) ?? null, named.get(key) ?? null));
        }
      },
    }),
  });
}

/**
 * Holds a cell for a command that waits on the clipboard, carried through
 * every change until the command lets it go.
 * @param view - The editor view.
 * @param pos - The position before the cell.
 * @returns Where the cell is now (null once it is gone), and the release.
 */
export function holdPendingCell(view: EditorView, pos: number): { readonly now: () => number | null; readonly release: () => void } {
  const key = Symbol('pending table cell');
  view.dispatch(view.state.tr.setMeta(pendingKey, { add: key, pos } satisfies PendingMeta).setMeta('addToHistory', false));
  return {
    now: () => (view.isDestroyed ? null : (pendingKey.getState(view.state)?.get(key) ?? null)),
    release: () => {
      if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(pendingKey, { drop: key } satisfies PendingMeta).setMeta('addToHistory', false));
    },
  };
}

/**
 * The extension that carries the plugins.
 * @returns The extension, for the assembly to register.
 */
export const documentTableTargetExtension = createExtension(() => ({
  key: 'document-table-target',
  prosemirrorPlugins: [tableTargetPlugin(), pendingCellsPlugin()],
}) as never);
