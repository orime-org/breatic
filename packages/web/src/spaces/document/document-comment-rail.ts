// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How the panel orders and groups its cards (#18, A4 · A5 · A9).
 *
 * Three answers come out of one reading. The cards go in body order (A4), the
 * resolved ones sit in their own collapsed group (A9), and whether anything is
 * unresolved is the dot on the `⋯` button (A5). They are computed together so
 * the dot cannot disagree with the group it stands for — it is the same list,
 * counted rather than counted again.
 *
 * Which group a thread is in follows from its state, and the state is the two
 * bits {@link commentCardState} reads. Unresolved and orphaned both go in the
 * first group, because an orphan is something the reader has not dealt with
 * yet (§9.2); resolved and resolved-orphaned go in the second.
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
  commentCardState,
  type CommentCardState,
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
  /** Which of the four states it is in, for what the card says. */
  readonly state: CommentCardState;
}

/** What the panel and the `⋯` button draw, off one reading. */
export interface CommentRail {
  /** Open and orphaned cards, in body order. */
  readonly unresolved: readonly RailCard[];
  /** Resolved cards, in the same order, for the collapsed group. */
  readonly resolved: readonly RailCard[];
  /** Whether the `⋯` button carries its dot. */
  readonly hasUnresolved: boolean;
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
 * @returns The two groups in body order, and whether the button is marked.
 */
export function commentRail(
  threads: readonly RailThread[],
  positions: ReadonlyMap<string, ThreadRange>,
): CommentRail {
  const sortable: Sortable[] = threads.map((thread) => ({
    id: thread.id,
    state: commentCardState(thread, thread.id, positions),
    from: positions.get(thread.id)?.from,
    opened: thread.createdAt.getTime(),
  }));
  sortable.sort(inBodyOrder);

  const unresolved = sortable.filter(
    (card) => card.state === 'open' || card.state === 'orphaned',
  );
  const resolved = sortable.filter(
    (card) => card.state === 'resolved' || card.state === 'resolvedOrphaned',
  );

  return {
    unresolved: unresolved.map(asCard),
    resolved: resolved.map(asCard),
    hasUnresolved: unresolved.length > 0,
  };
}

/**
 * Drops the sorting fields, leaving what a card is.
 * @param card - The sortable card.
 * @returns The card the panel draws.
 */
function asCard(card: Sortable): RailCard {
  return { id: card.id, state: card.state };
}
