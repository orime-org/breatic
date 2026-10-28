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
 *
 * A row or column menu also names its line, and the plugin marks every cell
 * of that line while the menu is open, in the look of selected cells, so the
 * reader sees what the commands will reach (the confirmed demo's flow, step
 * five). The reader's own selection is left as it was.
 */

import { createExtension } from '@blocknote/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

import { followCell, renameCell, type CellName } from '@web/spaces/document/document-table-cell-name';
import { cellsOfScope } from '@web/spaces/document/document-table-run';

/** The line a row or column menu acts on. */
type Line = 'row' | 'column';

/** The target cell, and the line its menu acts on when it is a line's. */
interface Held {
  readonly pos: number;
  readonly line: Line | null;
}

/** What a menu holds, or null when no menu holds a cell. */
type Target = Held | null;

/** The class on each cell of the held line. */
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
       * Marks the cells of the held line.
       * @param state - The editor state.
       * @returns The marks, or none.
       */
      decorations: (state): DecorationSet | null => {
        const held = tableTargetKey.getState(state) ?? null;
        if (held === null || held.line === null) return null;
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
 * @param line - The line a row or column menu acts on; none for the cell button.
 */
export function setTableTarget(view: EditorView, pos: number | null, line: Line | null = null): void {
  const held: Target = pos === null ? null : { pos, line };
  view.dispatch(view.state.tr.setMeta(tableTargetKey, held).setMeta('addToHistory', false));
}

/**
 * The extension that carries the plugin.
 * @returns The extension, for the assembly to register.
 */
export const documentTableTargetExtension = createExtension(() => ({
  key: 'document-table-target',
  prosemirrorPlugins: [tableTargetPlugin()],
}) as never);
