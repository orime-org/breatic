// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How the panel orders and groups its cards (#18, A4 · A5 · A9).
 *
 * Two answers come out of one reading: the cards in body order (A4), and the
 * resolved ones in their own group (A9). The dot on the `⋯` button is the
 * first group's length, counted where it is drawn.
 *
 * Which group a thread is in is whether it has been settled, and nothing
 * else. A thread whose words were all deleted is in neither: with its words
 * gone there is nothing on its card to read (A13). It stays in the document,
 * so an undo that brings its words back brings it back to the panel too.
 *
 * ORDER. Body order is the position table's `from`. Ties are broken by age so
 * the order is total. Two comments can start at the same offset — overlapping
 * ranges are allowed — and without a tie-break the list would be free to
 * reshuffle on any re-read.
 */

import type { ThreadRange } from '@web/spaces/document/document-comment-extension';

/** The half of a thread this reading needs. */
export interface RailThread {
  /** The thread's id, which is also what its marks carry. */
  readonly id: string;
  /** When it was opened, which orders threads the body cannot place. */
  readonly createdAt: Date;
  /** Absent reads the same as false: the store leaves it off until resolved. */
  readonly resolved?: boolean;
}

/** One card, as the panel draws it. */
export interface RailCard {
  /** Which thread this card is for. */
  readonly id: string;
  /** Whether it has been settled, which is the group it sits in. */
  readonly settled: boolean;
}

/** What the panel and the `⋯` button draw, off one reading. */
export interface CommentRail {
  /** Open cards, in body order. */
  readonly unresolved: readonly RailCard[];
  /** Resolved cards, in the same order, for the collapsed group. */
  readonly resolved: readonly RailCard[];
}

/** A card with what it takes to sort it. */
interface Sortable extends RailCard {
  /** Where its highlight starts. */
  readonly from: number;
  /** When the thread was opened, in milliseconds. */
  readonly opened: number;
}

/**
 * Compares two cards by body position, then by age.
 * @param a - One card.
 * @param b - The other.
 * @returns Negative when `a` comes first, positive when `b` does.
 */
function inBodyOrder(a: Sortable, b: Sortable): number {
  return a.from !== b.from ? a.from - b.from : a.opened - b.opened;
}

/**
 * Reads a set of threads into what the panel draws.
 * @param threads - Every thread in this document, in any order.
 * @param positions - Where each thread's marks reach in the body; a thread
 *   missing from it has lost the text it pointed at, and is left out.
 * @returns The two groups, each in body order.
 */
export function commentRail(
  threads: readonly RailThread[],
  positions: ReadonlyMap<string, ThreadRange>,
): CommentRail {
  const sortable: Sortable[] = threads.flatMap((thread) => {
    const from = positions.get(thread.id)?.from;
    return from === undefined
      ? []
      : [{
        id: thread.id,
        // `=== true` and not truthiness: the store leaves the field off until
        // somebody resolves the thread, so absent has to read as unresolved.
        settled: thread.resolved === true,
        from,
        opened: thread.createdAt.getTime(),
      }];
  });
  sortable.sort(inBodyOrder);

  return {
    unresolved: sortable.filter((card) => !card.settled).map(asCard),
    resolved: sortable.filter((card) => card.settled).map(asCard),
  };
}

/**
 * Drops the sorting fields, leaving what a card is.
 * @param card - The sortable card.
 * @returns The card the panel draws.
 */
function asCard(card: Sortable): RailCard {
  return { id: card.id, settled: card.settled };
}
