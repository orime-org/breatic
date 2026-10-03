// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The cell a table menu was opened on.
 *
 * A menu stays open while the document changes under it — a collaborator
 * typing above the table, adding a row, deleting one — so the cell is held as
 * a position in plugin state and mapped through every transaction, the way
 * ProseMirror maps decorations. When the cell itself is deleted the target is
 * cleared, and the menu has nothing left to act on. The plugin's `apply` is
 * the one place the target changes; a menu sets and clears it with a meta.
 */

import { createExtension } from '@blocknote/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { cellAt } from '@web/spaces/document/document-table-run';

/** The position before the target cell, or null when no menu holds one. */
type Target = number | null;

/** Where the target lives. */
const tableTargetKey = new PluginKey<Target>('document-table-target');

/**
 * The plugin that holds and maps the target.
 * @returns The plugin.
 */
function tableTargetPlugin(): Plugin<Target> {
  return new Plugin<Target>({
    key: tableTargetKey,
    state: {
      init: (): Target => null,
      apply: (tr, value): Target => {
        const set = tr.getMeta(tableTargetKey) as Target | undefined;
        if (set !== undefined) return set;
        if (value === null || !tr.docChanged) return value;
        const mapped = tr.mapping.mapResult(value, 1);
        if (mapped.deleted) return null;
        return cellAt(tr.doc, mapped.pos) === null ? null : mapped.pos;
      },
    },
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
