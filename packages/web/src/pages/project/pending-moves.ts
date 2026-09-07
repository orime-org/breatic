// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { applyTabMove, sameTabOrder } from '@breatic/shared';

/** One move the document has not accounted for yet. */
export interface OwedMove {
  /**
   * Names this move for as long as it is owed. Two things retire a move —
   * the document arriving with it applied, and its own reply saying the
   * server wrote nothing — and they can happen in either order. A name is
   * what lets both point at the same move; a position into the run cannot,
   * because retiring one shifts every other.
   */
  id: number;
  /** The tab that moved. */
  spaceId: string;
  /** The tab it landed in front of, null for the end. */
  beforeSpaceId: string | null;
}

/**
 * Lay a run of moves over an order.
 * @param stored - The order to start from.
 * @param moves - The moves to apply, oldest first.
 * @returns The order those moves produce.
 */
export function withMoves(
  stored: ReadonlyArray<string>,
  moves: ReadonlyArray<OwedMove>,
): ReadonlyArray<string> {
  return moves.reduce<ReadonlyArray<string>>(
    (ids, m) => applyTabMove(ids, m.spaceId, m.beforeSpaceId),
    stored,
  );
}

/**
 * Whether applying a move to an order would leave it as it is.
 *
 * True for a move already applied, and for one whose tab or anchor has since
 * left the list — nothing it asks for can be written either way.
 * @param stored - The order to apply it to.
 * @param move - The move.
 * @returns True when it would write nothing.
 */
export function changesNothing(
  stored: ReadonlyArray<string>,
  move: OwedMove | undefined,
): boolean {
  if (!move) return true;
  return sameTabOrder(
    applyTabMove(stored, move.spaceId, move.beforeSpaceId),
    stored,
  );
}

/**
 * How many moves at the front of the run the document already shows.
 *
 * Counting only from the front is what keeps a run meaningful: each move was
 * computed against the one before it.
 * @param stored - The order as the document has it.
 * @param moves - The moves still owed, oldest first.
 * @returns How many to drop.
 */
export function landedCount(
  stored: ReadonlyArray<string>,
  moves: ReadonlyArray<OwedMove>,
): number {
  let n = 0;
  while (n < moves.length) {
    if (!changesNothing(stored, moves[n])) break;
    n += 1;
  }
  return n;
}

/**
 * The oldest owed move that has not gone out.
 * @param moves - The moves still owed, oldest first.
 * @param sent - The names of the moves already on the wire.
 * @returns The move to send, or undefined when every one of them is out.
 */
export function nextUnsent(
  moves: ReadonlyArray<OwedMove>,
  sent: ReadonlySet<number>,
): OwedMove | undefined {
  return moves.find((m) => !sent.has(m.id));
}

/**
 * Drop one move from the run, leaving the others as they are.
 * @param moves - The moves still owed, oldest first.
 * @param id - The move to drop.
 * @returns The remaining run.
 */
export function retire(
  moves: ReadonlyArray<OwedMove>,
  id: number,
): ReadonlyArray<OwedMove> {
  return moves.filter((m) => m.id !== id);
}

/**
 * Drop one move and everything made on top of it.
 *
 * The moves behind a failed one were each computed against it. The ones ahead
 * of it stay: the server took them, and their broadcasts are on the way. A
 * move already gone from the run has been retired by its own broadcast, which
 * leaves the run whole.
 * @param moves - The moves still owed, oldest first.
 * @param id - The move that failed.
 * @returns The remaining run.
 */
export function rollbackFrom(
  moves: ReadonlyArray<OwedMove>,
  id: number,
): ReadonlyArray<OwedMove> {
  const at = moves.findIndex((m) => m.id === id);
  return at === -1 ? moves : moves.slice(0, at);
}
