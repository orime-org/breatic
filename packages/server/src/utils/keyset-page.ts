// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { encodeActivityCursor } from "@breatic/core";

/** One keyset page and the cursor that follows it. */
export interface KeysetPage<TView> {
  items: TView[];
  /** Feed back as `?cursor` for the next page; null at the end. */
  nextCursor: string | null;
}

/**
 * Build a keyset page out of one row over the asked-for size.
 *
 * The extra row is what distinguishes "the page is full" from "there is
 * more": counting the total would cost a second scan and would still be stale
 * by the time the next page is asked for.
 *
 * It follows that a page carrying a next cursor always carries a row, which
 * is what lets a list draw its foot only where it has rows.
 * @param rows - Rows fetched, one more than the page size.
 * @param size - The page size asked for.
 * @param map - How to turn a row into its view.
 * @param keyOf - The row's `(created_at::text, id)` for the cursor.
 * @returns The page and its next cursor.
 */
export function toPage<TRow, TView>(
  rows: TRow[],
  size: number,
  map: (row: TRow) => TView,
  keyOf: (row: TRow) => { cursorAt: string; id: string },
): KeysetPage<TView> {
  const hasMore = rows.length > size;
  const page = hasMore ? rows.slice(0, size) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(map),
    nextCursor:
      hasMore && last
        ? encodeActivityCursor(keyOf(last).cursorAt, keyOf(last).id)
        : null,
  };
}
