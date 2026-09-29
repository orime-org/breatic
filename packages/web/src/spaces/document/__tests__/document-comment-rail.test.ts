// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How the panel orders and groups its cards (#18, A4 · A5 · A9).
 *
 * Two answers come out of one reading: the cards in body order (A4), and the
 * resolved ones in their own group (A9). The dot on the `⋯` button is the
 * first group's length, counted in `DocumentEditor` rather than here.
 *
 * Body order leaves one case open, and the design's own transition table is
 * what opens it: a thread whose text was deleted stays in the unresolved
 * group (§9.2), and it has no position to sort by. They go last, oldest
 * first — sorting them among the others would need a position they do not
 * have, and any stand-in would make the list jump at the moment a peer
 * deletes the text.
 *
 * TDD: red because `commentRail` does not exist yet.
 */

import { describe, it, expect } from 'vitest';

import {
  commentRail,
  type RailThread,
} from '@web/spaces/document/document-comment-rail';

const AT = (day: number): Date =>
  new Date(Date.UTC(2026, 8, day, 0, 0, 0));

/** A thread, unresolved unless said otherwise. */
const thread = (
  id: string,
  day: number,
  resolved?: boolean,
): RailThread => ({ id, createdAt: AT(day), resolved });

/** A position table placing each id named at the offset given. */
const at = (
  ...pairs: readonly [string, number][]
): ReadonlyMap<string, { from: number; to: number }> =>
  new Map(pairs.map(([id, from]) => [id, { from, to: from + 5 }]));

/** Just the ids, in the order the rail put them. */
const ids = (cards: readonly { id: string }[]): string[] =>
  cards.map((card) => card.id);

describe('commentRail', () => {
  it('puts the cards in body order, not the order they were written', () => {
    const rail = commentRail(
      [thread('late-in-body', 1), thread('early-in-body', 2)],
      at(['late-in-body', 90], ['early-in-body', 10]),
    );
    expect(ids(rail.unresolved)).toEqual(['early-in-body', 'late-in-body']);
  });

  it('breaks a tie on the same start by age, oldest first', () => {
    // Two comments can start at the same offset — overlapping ranges are
    // allowed — and a stable order keeps the list from reshuffling.
    const rail = commentRail(
      [thread('newer', 2), thread('older', 1)],
      at(['newer', 10], ['older', 10]),
    );
    expect(ids(rail.unresolved)).toEqual(['older', 'newer']);
  });

  it('sends a resolved thread to its own group', () => {
    const rail = commentRail(
      [thread('done', 1, true), thread('live', 2)],
      at(['done', 10], ['live', 20]),
    );
    expect(ids(rail.unresolved)).toEqual(['live']);
    expect(ids(rail.resolved)).toEqual(['done']);
  });

  it.each([
    ['an open', false],
    ['a resolved', true],
  ])('leaves out %s thread whose text was deleted', (_what, resolved) => {
    // A13: the words are gone, so there is nothing on the card to read.
    const rail = commentRail(
      [thread('gone', 1, resolved), thread('placed', 2)],
      at(['placed', 90]),
    );
    expect(ids(rail.unresolved)).toEqual(['placed']);
    expect(ids(rail.resolved)).toEqual([]);
  });

  it('empties it when everything is resolved', () => {
    const rail = commentRail(
      [thread('done', 1, true), thread('also-done', 2, true)],
      at(['done', 10]),
    );
    expect(rail.unresolved).toEqual([]);
  });

  it('answers with two empty groups when there are no threads at all', () => {
    const rail = commentRail([], at());
    expect(rail.unresolved).toEqual([]);
    expect(rail.resolved).toEqual([]);
  });

  it('orders the resolved group the same way', () => {
    const rail = commentRail(
      [thread('late', 2, true), thread('early', 3, true)],
      at(['late', 90], ['early', 10]),
    );
    expect(ids(rail.resolved)).toEqual(['early', 'late']);
  });
});
