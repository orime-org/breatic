// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The insert menu's entries and which of them are out of reach on a row
 * (inner#1125 design 5.2). The plus menu, the handle's insert-below submenu
 * and the slash menu read these, so the three list and grey the same rows.
 */

import type { Node as PMNode } from '@tiptap/pm/model';

import { columnsOutOfReach } from '@web/spaces/document/document-column-entry';
import { DIVIDER } from '@web/spaces/document/document-divider';
import { INSERT_MENU_ROWS } from '@web/spaces/document/document-insert-menu-items';
import { COLUMNS, FORMULA } from '@web/spaces/document/document-insert-row';
import { QUOTED } from '@web/spaces/document/document-list-block';
import { blockInTableCell } from '@web/spaces/document/document-table-nodes';

/** The entries, in menu order: block types, then divider, table, columns, formula, then media. */
export const INSERT_ENTRY_IDS = [
  ...INSERT_MENU_ROWS,
  DIVIDER,
  'table',
  COLUMNS,
  FORMULA,
  'image',
  'audio',
  'video',
] as const;

/** One entry of the insert menu. */
export type InsertEntryId = (typeof INSERT_ENTRY_IDS)[number];

/**
 * How a pick acts on the row: it turns the row itself into the pick (the plus
 * menu, the slash menu on a line with no text) or adds a row below it (the
 * insert-below submenu, the slash menu on a line with text).
 */
export type InsertMode = 'fill' | 'below';

/**
 * Whether the content of the block a block id names is quoted.
 * @param doc - The document.
 * @param blockId - The block.
 * @returns True when the block carries the quote.
 */
function blockQuoted(doc: PMNode, blockId: string): boolean {
  let quoted = false;
  doc.descendants((node) => {
    if (node.attrs['id'] !== blockId) return !quoted;
    quoted = node.firstChild?.attrs[QUOTED] === true;
    return false;
  });
  return quoted;
}

/**
 * The entries a pick on this row cannot carry out.
 *
 * Quote is out of reach only when the row turns into the pick: a quoted row
 * made into a quote stays as it was. Below, the new row inherits the quote and
 * Quote gives a quoted row (`document-block-run.ts`).
 * @param doc - The document.
 * @param blockId - The row.
 * @param mode - How the pick acts on it.
 * @returns The entries drawn out of reach.
 */
export function insertReach(doc: PMNode, blockId: string, mode: InsertMode): ReadonlySet<InsertEntryId> {
  const out = new Set<InsertEntryId>();
  if (blockInTableCell(doc, blockId)) out.add('table');
  if (columnsOutOfReach(doc, blockId)) out.add(COLUMNS);
  if (mode === 'fill' && blockQuoted(doc, blockId)) out.add('quote');
  return out;
}

/**
 * A reach as a string, for readings compared by value.
 * @param reach - The entries out of reach.
 * @returns Their ids, sorted and joined.
 */
export function reachKey(reach: ReadonlySet<InsertEntryId>): string {
  return [...reach].sort().join(',');
}

/**
 * The reach a {@link reachKey} string stands for.
 * @param key - The string.
 * @returns The entries out of reach.
 */
export function reachFromKey(key: string): ReadonlySet<InsertEntryId> {
  return new Set(key === '' ? [] : (key.split(',') as InsertEntryId[]));
}
