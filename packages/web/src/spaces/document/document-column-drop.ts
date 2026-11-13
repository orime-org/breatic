// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Dropping a dragged row beside another to make or grow a column group
 * (inner#1314 design §5.2).
 */

import type { BlockNoteEditor } from '@blocknote/core';

/** Which side of the target the row lands on. */
export type ColumnSide = 'left' | 'right';

/**
 * Lands a row beside a target row: wraps the two in a new group, or adds a
 * column to the target's group.
 * @param _editor - The editor.
 * @param _draggedId - The dragged row's id.
 * @param _targetId - The target row's id.
 * @param _side - Which side of the target.
 * @returns Whether anything was written.
 */
export function dropRowBeside(
  _editor: BlockNoteEditor<never, never, never>,
  _draggedId: string,
  _targetId: string,
  _side: ColumnSide,
): boolean {
  return false;
}
