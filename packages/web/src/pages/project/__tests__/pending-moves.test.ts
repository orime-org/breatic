// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';

import {
  changesNothing,
  landedCount,
  nextUnsent,
  retire,
  rollbackFrom,
  withMoves,
  type OwedMove,
} from '@web/pages/project/pending-moves';

const STORED = ['a', 'b', 'c'];

/**
 * Builds one owed move.
 * @param id - Names it for as long as it is owed.
 * @param spaceId - The tab that moved.
 * @param beforeSpaceId - The tab it landed in front of, null for the end.
 * @returns The move.
 */
function move(
  id: number,
  spaceId: string,
  beforeSpaceId: string | null,
): OwedMove {
  return { id, spaceId, beforeSpaceId };
}

describe('withMoves', () => {
  it('hands back the stored order when nothing is owed', () => {
    expect(withMoves(STORED, [])).toEqual(STORED);
  });

  it('applies one move', () => {
    expect(withMoves(STORED, [move(1, 'c', 'a')])).toEqual(['c', 'a', 'b']);
  });

  it('applies a run in the order it was made', () => {
    expect(withMoves(STORED, [move(1, 'c', 'a'), move(2, 'b', 'c')])).toEqual([
      'b',
      'c',
      'a',
    ]);
  });
});

describe('changesNothing', () => {
  it('is true for a move the order already shows', () => {
    expect(changesNothing(['c', 'a', 'b'], move(1, 'c', 'a'))).toBe(true);
  });

  it('is false for a move the order does not show yet', () => {
    expect(changesNothing(STORED, move(1, 'c', 'a'))).toBe(false);
  });

  it('is true when the tab that moved has left the list', () => {
    expect(changesNothing(['a', 'b'], move(1, 'c', 'a'))).toBe(true);
  });

  it('is true when the anchor has left the list', () => {
    expect(changesNothing(['b', 'c'], move(1, 'c', 'a'))).toBe(true);
  });

  it('is true when there is no move', () => {
    expect(changesNothing(STORED, undefined)).toBe(true);
  });
});

describe('landedCount', () => {
  it('counts nothing when the front move is still owed', () => {
    expect(landedCount(STORED, [move(1, 'c', 'a'), move(2, 'b', 'c')])).toBe(0);
  });

  it('counts the run the order already shows', () => {
    expect(landedCount(['c', 'a', 'b'], [move(1, 'c', 'a')])).toBe(1);
  });

  it('stops at the first move the order does not show', () => {
    // Each move was computed on top of the one before, so a later move can
    // read as landed against an order that never had the earlier one applied.
    const moves = [move(1, 'b', 'a'), move(2, 'c', 'a')];
    expect(landedCount(['c', 'a', 'b'], moves)).toBe(0);
  });

  it('counts every move once the order shows them all', () => {
    const moves = [move(1, 'c', 'a'), move(2, 'b', 'c')];
    expect(landedCount(withMoves(STORED, moves), moves)).toBe(2);
  });
});

describe('nextUnsent', () => {
  it('names the first move that has not gone out', () => {
    const moves = [move(1, 'c', 'a'), move(2, 'b', 'c')];
    expect(nextUnsent(moves, new Set([1]))?.id).toBe(2);
  });

  it('has nothing while every owed move is out', () => {
    const moves = [move(1, 'c', 'a')];
    expect(nextUnsent(moves, new Set([1]))).toBeUndefined();
  });

  it('has nothing when nothing is owed', () => {
    expect(nextUnsent([], new Set())).toBeUndefined();
  });
});

describe('retire', () => {
  it('drops the named move and keeps the rest in order', () => {
    const moves = [move(1, 'c', 'a'), move(2, 'b', 'c'), move(3, 'a', null)];
    expect(retire(moves, 2).map((m) => m.id)).toEqual([1, 3]);
  });

  it('hands the run back when the move has already gone', () => {
    const moves = [move(1, 'c', 'a')];
    expect(retire(moves, 9)).toEqual(moves);
  });
});

describe('rollbackFrom', () => {
  it('drops the named move and everything made on top of it', () => {
    const moves = [move(1, 'c', 'a'), move(2, 'b', 'c'), move(3, 'a', null)];
    expect(rollbackFrom(moves, 2).map((m) => m.id)).toEqual([1]);
  });

  it('keeps the run whole when the move has already gone', () => {
    // Its broadcast arrived first and retired it. The moves behind it were
    // computed on an order that already holds it, so they still stand.
    const moves = [move(1, 'c', 'a'), move(2, 'b', 'c')];
    expect(rollbackFrom(moves, 9)).toEqual(moves);
  });

  it('empties the run when the first move fails', () => {
    const moves = [move(1, 'c', 'a'), move(2, 'b', 'c')];
    expect(rollbackFrom(moves, 1)).toEqual([]);
  });
});
