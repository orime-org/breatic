// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which rows the block-type menu ticks, and which one the slot shows.
 *
 * Every fact the nine rows are judged on sits on the block's own content node
 * in BlockNote's flat model: its type name, its `level`, and the `numbered`
 * and `quoted` props. Asking a block what it is therefore costs one node
 * lookup, where the nested model had to walk outwards through list and quote
 * ancestors to find out.
 *
 * Two rules from §3.1 decide the rest:
 *
 * - The eight content rows are mutually exclusive, except that an ordered list
 *   coexists with any one heading. Quote sits across all eight.
 * - A row ticks only when EVERY block the selection covers is that row. An
 *   empty selection ticks nothing: "every block is" would otherwise hold for
 *   all nine at once over an empty set.
 */

import type { Node as PMNode } from '@tiptap/pm/model';
import type { Selection } from '@tiptap/pm/state';

import { ORDERED_LIST } from '@web/spaces/document/document-list-block';

/** The nine rows the menu offers. */
export type BlockTypeId =
  | 'paragraph'
  | 'heading-1'
  | 'heading-2'
  | 'heading-3'
  | 'bullet-list'
  | 'ordered-list'
  | 'quote'
  | 'code-block'
  | 'task-list';

/**
 * Every row, in the order the face is looked up.
 *
 * The three headings come before `ordered-list` because those two rows can
 * both hold at once, and what the reader sees on such a line is a heading —
 * the heading's size, with a heading path where a list marker would be. The
 * face answers "what am I looking at", so it answers with that.
 */
const ROWS: readonly BlockTypeId[] = [
  'heading-1',
  'heading-2',
  'heading-3',
  'bullet-list',
  'ordered-list',
  'task-list',
  'code-block',
  'paragraph',
  'quote',
];

/**
 * The eight the face is chosen from.
 *
 * Quote is left out because it is orthogonal: a quoted heading's face is the
 * heading (#928). Expressing that by leaving the row out of the list, rather
 * than by testing for it at the lookup, is what keeps the rule from depending
 * on where Quote happens to sit in `ROWS`.
 */
export const CONTENT_ROWS: readonly BlockTypeId[] = ROWS.filter((id) => id !== 'quote');

/** Which of a block's three independent properties a row sets. */
export type BlockTypeDimension = 'type' | 'numbered' | 'quoted';

/**
 * The five rows that name a block type.
 *
 * The three headings are out because their row does not name a type: all
 * three become `heading` and differ by level, which `LEVEL_OF_ROW` below
 * carries. Quote is out because it is a prop rather than a type. Ordered is
 * IN — it names `numberedListItem` on every block but a heading, where it is
 * a prop instead (§3.1).
 */
export type TypeRow = Exclude<BlockTypeId, 'heading-1' | 'heading-2' | 'heading-3' | 'quote'>;

/**
 * Which of the menu's three groups a row is in (user 2026-09-02).
 *
 * The seven that set the block's type exclude one another. Ordered coexists
 * with a heading and replaces any other type (§3.1). Quote coexists with all
 * of them.
 *
 * A total record rather than a partial one: adding a tenth row leaves this
 * failing to compile until the row says which of the three it sets, and the
 * menu's rules are drawn from it, so the grouping cannot fall behind the rows.
 */
export const DIMENSION_OF_ROW: Readonly<Record<BlockTypeId, BlockTypeDimension>> = {
  paragraph: 'type',
  'heading-1': 'type',
  'heading-2': 'type',
  'heading-3': 'type',
  'code-block': 'type',
  'bullet-list': 'type',
  'task-list': 'type',
  'ordered-list': 'numbered',
  quote: 'quoted',
};

/**
 * The block type each non-heading row turns a block into.
 *
 * Total over the rows that name a block type, so a tenth row of that kind
 * leaves this failing to compile until it says what it becomes. Exported
 * because `document-block-run.ts` writes what `ROW_OF_TYPE` below reads: one
 * table, so the two cannot drift apart.
 */
export const TYPE_OF_ROW: Readonly<Record<TypeRow, string>> = {
  paragraph: 'paragraph',
  'code-block': 'codeBlock',
  'bullet-list': 'bulletListItem',
  'ordered-list': ORDERED_LIST,
  'task-list': 'checkListItem',
};

/** The row each plain block type stands for, read off the table above. */
const ROW_OF_TYPE: Readonly<Record<string, BlockTypeId>> = Object.fromEntries(
  Object.entries(TYPE_OF_ROW).map(([row, type]) => [type, row]),
) as Readonly<Record<string, BlockTypeId>>;

/**
 * The heading level each heading row stands for.
 *
 * Exported because `document-block-run.ts` writes the level this table reads:
 * one table, so a fourth heading cannot arrive on one side of that pair and
 * not the other.
 */
export const LEVEL_OF_ROW: Readonly<Partial<Record<BlockTypeId, number>>> = {
  'heading-1': 1,
  'heading-2': 2,
  'heading-3': 3,
};

/**
 * The content node of the block a position sits in.
 * @param doc - The document.
 * @param pos - A position inside a block.
 * @returns That block's content node, or null when the position is not in one.
 */
function contentAt(doc: PMNode, pos: number): PMNode | null {
  if (pos < 0 || pos > doc.content.size) {
    return null;
  }
  const $pos = doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (node.type.name in ROW_OF_TYPE || node.type.name === 'heading') {
      return node;
    }
  }
  return null;
}

/**
 * Whether one block is a given row.
 * @param content - The block's content node.
 * @param id - Which row.
 * @returns Whether the row holds for it.
 */
function isRow(content: PMNode, id: BlockTypeId): boolean {
  if (id === 'quote') {
    return content.attrs['quoted'] === true;
  }
  const level = LEVEL_OF_ROW[id];
  if (level !== undefined) {
    return content.type.name === 'heading' && content.attrs['level'] === level;
  }
  if (id === 'ordered-list' && content.type.name === 'heading') {
    // An ordered list and a heading coexist: the block stays an ordered item
    // and shows a heading (§3.1).
    return content.attrs['numbered'] === true;
  }
  return ROW_OF_TYPE[content.type.name] === id;
}

/**
 * The content node of every block the selection covers, in document order.
 * @param doc - The document.
 * @param selection - The selection over it.
 * @returns Those nodes.
 */
function blocksUnder(doc: PMNode, selection: Selection): PMNode[] {
  const found: PMNode[] = [];
  doc.nodesBetween(selection.from, selection.to, (node) => {
    if (!node.isTextblock) {
      return true;
    }
    found.push(node);
    return false;
  });
  return found;
}

/**
 * Every row ticked over a selection.
 * @param doc - The document.
 * @param selection - The selection over it.
 * @returns The ticked rows.
 */
export function tickedOver(doc: PMNode, selection: Selection): Set<BlockTypeId> {
  const blocks = blocksUnder(doc, selection);
  if (blocks.length === 0) {
    return new Set();
  }
  return new Set(ROWS.filter((id) => blocks.every((content) => isRow(content, id))));
}

/**
 * The row each block the selection covers stands for.
 *
 * Chosen from the eight content rows for the same reason the face is: quote
 * sits across all of them, so a quoted heading counts as a heading.
 * @param doc - The document.
 * @param selection - The selection over it.
 * @returns One row per block, in document order. A block that is none of the
 *   eight — a fallback node standing in for a type this version cannot draw —
 *   contributes nothing.
 */
export function rowsUnder(doc: PMNode, selection: Selection): BlockTypeId[] {
  const rows: BlockTypeId[] = [];
  blocksUnder(doc, selection).forEach((content) => {
    const row = CONTENT_ROWS.find((id) => isRow(content, id));
    if (row !== undefined) rows.push(row);
  });
  return rows;
}

/**
 * Which row the slot shows as this selection's face.
 *
 * The end the reader anchored on, so the face answers "what am I in" rather
 * than going blank over a selection spanning two types (user 2026-08-27). An
 * anchor that resolves outside any block — a select-all, a node selection —
 * falls to the first block the selection covers.
 * @param doc - The document.
 * @param selection - The selection over it.
 * @returns That row, `paragraph` when the selection covers no block at all.
 */
export function faceOf(doc: PMNode, selection: Selection): BlockTypeId {
  const anchored = contentAt(doc, selection.anchor);
  const content = anchored ?? blocksUnder(doc, selection)[0];
  if (content === undefined) {
    return 'paragraph';
  }
  return CONTENT_ROWS.find((id) => isRow(content, id)) ?? 'paragraph';
}
