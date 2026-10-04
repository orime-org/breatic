// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The bubble bar's table command: merging the selected cells (inner#1126 A10).
 * It is on the bar only while cells are selected.
 */

import { CellSelection } from '@tiptap/pm/tables';
import { TableCellsMerge } from 'lucide-react';

import { canMergeCells, mergeSelectedCells } from '@web/spaces/document/document-table-run';
import type { ToolDef, ToolEditor } from '@web/spaces/document/document-tool-button';

/** Merges the selected cells into one. */
export const mergeCellsTool: ToolDef = {
  id: 'mergeCells',
  labelKey: 'spaces.document.table.mergeCells',
  Icon: TableCellsMerge,

  /**
   * Whether a merge would do something here.
   * @param editor - The editor.
   * @returns True over two cells or more that can be merged.
   */
  canRun: (editor: ToolEditor): boolean => canMergeCells(editor.prosemirrorState),

  /**
   * Never pressed: merging is an action, not a state cells are in.
   * @returns False.
   */
  isActive: (): boolean => false,

  /**
   * Merges the selected cells.
   * @param editor - The editor.
   */
  run: (editor: ToolEditor): void => {
    mergeSelectedCells(editor as never);
  },

  /**
   * On the bar while cells are selected.
   * @param editor - The editor.
   * @returns True over a selection of cells.
   */
  shownWhen: (editor: ToolEditor): boolean =>
    editor.prosemirrorState.selection instanceof CellSelection,
};
