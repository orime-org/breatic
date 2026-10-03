// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The cell a table menu was opened on.
 *
 * A menu stays open while the document changes under it — a collaborator
 * typing above the table, adding a row, deleting one — so the cell is held as
 * a position in plugin state and carried through every transaction: the
 * reader's own edits by mapping, the way ProseMirror maps decorations, and
 * changes that come in through Yjs by the element the cell is bound to
 * (`document-table-cell-name.ts`). When the cell itself is deleted the target
 * is cleared, and the menu has nothing left to act on. The plugin's `apply` is
 * the one place the target changes; a menu sets and clears it with a meta.
 */

import { createExtension } from '@blocknote/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { followCell, renameCell, type CellName } from '@web/spaces/document/document-table-cell-name';

/** The position before the target cell, or null when no menu holds one. */
type Target = number | null;

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
        return followCell(tr, before, value, named);
      },
    },
    view: () => ({
      update: (view, prev): void => {
        const target = tableTargetKey.getState(view.state) ?? null;
        named = renameCell(view.state, prev, target, tableTargetKey.getState(prev) ?? null, named);
      },
    }),
  });
}

/**
 * The cell a table menu holds.
 * @param state - The editor state.
 * @returns The position before the cell, or null.
 */
export function tableTargetOf(state: EditorState): Target {
  return tableTargetKey.getState(state) ?? null;
}

/**
 * Sets or clears the cell a table menu acts on.
 * @param view - The editor view.
 * @param target - The position before the cell, or null to clear it.
 */
export function setTableTarget(view: EditorView, target: Target): void {
  view.dispatch(view.state.tr.setMeta(tableTargetKey, target).setMeta('addToHistory', false));
}

/**
 * The extension that carries the plugin.
 * @returns The extension, for the assembly to register.
 */
export const documentTableTargetExtension = createExtension(() => ({
  key: 'document-table-target',
  prosemirrorPlugins: [tableTargetPlugin()],
}) as never);
