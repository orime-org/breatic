// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The shot list's column widths (inner#1130). The storyboard tool answers one
 * table of eight columns in a fixed order, and the column names follow the
 * user's language, so the widths go by position: narrow for the shot number,
 * the shot size, the angles and the seconds, wide for what is on screen and
 * the sound. A table of any other shape keeps the default width.
 */

import type { AiAnswer } from '@web/spaces/document/document-ai-text';
import type { WrittenBlock } from '@web/spaces/document/document-external-media';
import { DOC_TABLE } from '@web/spaces/document/document-table-nodes';

/** Each column's width in pixels, in the order the storyboard prompt asks for. */
const SHOT_LIST_COLUMN_WIDTHS = [64, 88, 88, 88, 220, 180, 64, 140] as const;

/**
 * Whether every row of a table holds exactly the shot list's columns, none spanning more than one.
 * @param table - The table block.
 * @returns True for a shot list.
 */
function holdsShotList(table: WrittenBlock): boolean {
  const rows = table.children ?? [];
  return rows.length > 0 && rows.every((row) => {
    const cells = row.children ?? [];
    return cells.length === SHOT_LIST_COLUMN_WIDTHS.length && cells.every((cell) => (cell.props?.['colspan'] ?? 1) === 1);
  });
}

/**
 * The answer with the shot list's column widths on every table that holds it.
 * @param answer - The answer, as `aiAnswer` reads it.
 * @returns The answer, its shot list tables sized.
 */
export function withShotListWidths(answer: AiAnswer): AiAnswer {
  const preview = answer.preview.map((block) => {
    if (block.type !== DOC_TABLE || !holdsShotList(block)) return block;
    return {
      ...block,
      children: (block.children ?? []).map((row) => ({
        ...row,
        children: (row.children ?? []).map((cell, column) => ({
          ...cell,
          props: { ...cell.props, colwidth: [SHOT_LIST_COLUMN_WIDTHS[column]] },
        })),
      })),
    };
  });
  return { ...answer, preview };
}
