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
 * else. A thread whose words were deleted stays with the unresolved ones,
 * because it is something the reader has not dealt with yet (§9.2).
 *
 * ORDER. Body order is the position table's `from`. That leaves the orphans,
 * which have no position — the design's transition table keeps them in the
 * unresolved group (§9.2), so they have to go somewhere. They go last, oldest
 * first: sorting them among the others would need a position they do not
 * have, and any stand-in would move the list at the moment a peer deletes the
 * text, which is exactly when the reader is looking at it.
 *
 * Ties are broken by age so the order is total. Two comments can start at the
 * same offset — overlapping ranges are allowed — and without a tie-break the
 * list would be free to reshuffle on any re-read.
 */

import {
  isSettled,
  type ThreadRange,
} from '@web/spaces/document/document-comment-state';

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
  /** Open and orphaned cards, in body order. */
  readonly unresolved: readonly RailCard[];
  /** Resolved cards, in the same order, for the collapsed group. */
  readonly resolved: readonly RailCard[];
}

/** A card with what it takes to sort it. */
interface Sortable extends RailCard {
  /** Where its highlight starts, or nothing when the text is gone. */
  readonly from: number | undefined;
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
  if (a.from !== b.from) {
    // One of them has lost its text: that one goes after everything the body
    // can still place.
    if (a.from === undefined) return 1;
    if (b.from === undefined) return -1;
    return a.from - b.from;
  }
  return a.opened - b.opened;
}

/**
 * Reads a set of threads into what the panel draws.
 * @param threads - Every thread in this document, in any order.
 * @param positions - Where each thread's marks reach in the body; a thread
 *   missing from it has lost the text it pointed at.
 * @returns The two groups, each in body order.
 */
export function commentRail(
  threads: readonly RailThread[],
  positions: ReadonlyMap<string, ThreadRange>,
): CommentRail {
  const sortable: Sortable[] = threads.map((thread) => ({
    id: thread.id,
    settled: isSettled(thread),
    from: positions.get(thread.id)?.from,
    opened: thread.createdAt.getTime(),
  }));
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
