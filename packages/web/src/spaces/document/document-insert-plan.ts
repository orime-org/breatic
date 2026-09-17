// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What pressing the plus on a row does before the insert menu opens.
 *
 * The menu needs two things from the document: a caret to anchor on, and a
 * place for the query the reader types — the suggestion plugin keeps that
 * query as document text (`SuggestionMenu.ts`, `queryStartPos`), so it always
 * lands in a block. An empty paragraph already is that place; every other row
 * gets one made below it.
 */

import { rowPaintsSomething } from '@web/spaces/document/document-hovered-block';

/** The part of a BlockNote block this file reads. */
export interface PressedRow {
  /** Which kind of block it is. */
  readonly type: string;
  /** Its props, of which only the quote matters here. */
  readonly props?: Readonly<Record<string, unknown>>;
  /** Its own inline content. */
  readonly content?: readonly unknown[];
  /** Blocks nested under it. */
  readonly children?: readonly unknown[];
}

/**
 * Whether the insert menu can open in the pressed row itself.
 *
 * Its own question, though today it has one answer: a row the reader sees
 * nothing on is the empty row they were asking for, and it is also the only
 * kind the menu can live in — the plugin drops every transaction whose
 * selection sits in a code block (`SuggestionMenu.ts:257-260`), and a code
 * block paints while empty, so it is never in this set.
 * @param row - The block the plus was pressed on.
 * @returns True when the menu opens in that row rather than under it.
 */
export function menuOpensInRow(row: PressedRow): boolean {
  return !rowPaintsSomething(row);
}

/** Where the insert menu opens, and what a block made for it carries. */
export interface InsertPlan {
  /** `inPlace` opens on the pressed row itself; `below` makes one under it. */
  readonly where: 'inPlace' | 'below';
  /** Props for the block made below, empty when the menu opens in place. */
  readonly props: Readonly<Record<string, unknown>>;
}

/**
 * Where the insert menu should open for the row the plus was pressed on.
 *
 * The menu opens in place on a row the reader sees nothing on, so the row they
 * pointed at becomes what they choose. Two rows look empty and are not
 * ({@link rowPaintsSomething}): a code block draws its frame, and a list item
 * can have its own text deleted while items stay indented under it. Keeping
 * the code block out of the in-place case is what makes the menu appear at
 * all — `SuggestionMenu.ts:257-260` drops every transaction whose selection
 * sits in one, so the meta that opens the menu is never read.
 *
 * A block made below carries the quote of the row it was made under, so that
 * pressing the plus inside a quote keeps the new row in the quote — the same
 * place pressing Enter there would put it. The schema defaults `quoted` to
 * false (`document-schema-blocknote.ts:53`), which would otherwise break the
 * quote in two.
 * @param row - The block the plus was pressed on.
 * @returns Where to open and what the new block carries.
 */
export function insertPlanFor(row: PressedRow): InsertPlan {
  const inPlace = menuOpensInRow(row);
  return {
    where: inPlace ? 'inPlace' : 'below',
    props: inPlace ? {} : { quoted: row.props?.quoted === true },
  };
}
