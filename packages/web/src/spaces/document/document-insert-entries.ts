// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The insert menu's entries and which of them are out of reach on a row
 * (inner#1125 design 5.2). The plus menu, the handle's insert-below submenu
 * and the slash menu read these, so the three list and grey the same rows.
 */

import type { Node as PMNode } from '@tiptap/pm/model';
import { Columns2, Image as ImageIcon, Minus, Music, Sigma, Table, Video, type LucideIcon } from 'lucide-react';

import { DIMENSION_OF_ROW, type BlockTypeId } from '@web/spaces/document/document-block-ticks';
import { blockTypeItem } from '@web/spaces/document/document-block-type';
import { columnsOutOfReach } from '@web/spaces/document/document-column-entry';
import { DIVIDER } from '@web/spaces/document/document-divider';
import { INSERT_MENU_ROWS } from '@web/spaces/document/document-insert-menu-items';
import { COLUMNS, FORMULA } from '@web/spaces/document/document-insert-row';
import { QUOTED } from '@web/spaces/document/document-list-block';
import { holdsNestedBlocks, rowById } from '@web/spaces/document/document-row-by-id';
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

/** The media entries, which open the file picker instead of inserting a block. */
export const MEDIA_ENTRY_IDS: ReadonlySet<InsertEntryId> = new Set<InsertEntryId>(['image', 'audio', 'video']);

/** The entries offered where no file can be picked. */
export const INSERT_ENTRY_IDS_WITHOUT_MEDIA: readonly InsertEntryId[] = INSERT_ENTRY_IDS.filter(
  (id) => !MEDIA_ENTRY_IDS.has(id),
);

/** What an entry draws: its icon and the key of its name. */
export interface InsertEntryLook {
  readonly Icon: LucideIcon;
  readonly labelKey: string;
}

/** The entries that are not block types, by id. */
const OTHER_LOOKS: Readonly<Record<string, InsertEntryLook>> = {
  [DIVIDER]: { Icon: Minus, labelKey: 'spaces.document.commands.divider' },
  table: { Icon: Table, labelKey: 'spaces.document.commands.table' },
  [COLUMNS]: { Icon: Columns2, labelKey: 'spaces.document.commands.columns' },
  [FORMULA]: { Icon: Sigma, labelKey: 'spaces.document.commands.formula' },
  image: { Icon: ImageIcon, labelKey: 'spaces.document.media.image' },
  audio: { Icon: Music, labelKey: 'spaces.document.media.audio' },
  video: { Icon: Video, labelKey: 'spaces.document.media.video' },
};

/**
 * The icon and name an entry is drawn with, in every menu that lists it. A
 * block type reads its own row of the block type menu.
 * @param id - The entry.
 * @returns Its icon and the key of its name.
 */
export function insertEntryLook(id: InsertEntryId): InsertEntryLook {
  return OTHER_LOOKS[id] ?? blockTypeItem(id as BlockTypeId);
}

/**
 * The group an entry sits in. A rule is drawn wherever two neighbouring
 * entries are in different groups: block types group by dimension, as the
 * block type menu does, and the rest share one group.
 * @param id - The entry.
 * @returns Its group.
 */
export function insertEntryGroup(id: InsertEntryId): string {
  return id in OTHER_LOOKS ? 'insert' : DIMENSION_OF_ROW[id as BlockTypeId];
}

/**
 * Whether a rule sits between two neighbouring entries of a menu.
 * @param previous - The entry above, if any.
 * @param id - The entry below.
 * @returns True when they are in different groups.
 */
export function ruleBetween(previous: InsertEntryId | undefined, id: InsertEntryId): boolean {
  return previous !== undefined && insertEntryGroup(previous) !== insertEntryGroup(id);
}

/**
 * How a pick acts on the row: it turns the row itself into the pick (the plus
 * menu, the slash menu on a block holding nothing but the trigger and the
 * query) or adds a row below it (the insert-below submenu, the slash menu on
 * any other block).
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
 * Quote gives a quoted row (`document-block-run.ts`). Table is out of reach
 * when it would fill a row with blocks indented under it, whose own rows
 * would replace them.
 * @param doc - The document.
 * @param blockId - The row.
 * @param mode - How the pick acts on it.
 * @returns The entries drawn out of reach.
 */
export function insertReach(doc: PMNode, blockId: string, mode: InsertMode): ReadonlySet<InsertEntryId> {
  const out = new Set<InsertEntryId>();
  if (blockInTableCell(doc, blockId)) out.add('table');
  if (mode === 'fill') {
    const row = rowById(doc, blockId);
    if (row !== undefined && holdsNestedBlocks(row)) out.add('table');
  }
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
