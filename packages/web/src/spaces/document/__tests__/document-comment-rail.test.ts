// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How the panel orders and groups its cards (#18, A4 · A5 · A9).
 *
 * Three acceptance items read one answer. The cards go in body order (A4),
 * resolved ones sit in their own collapsed group that a reader can switch to
 * (A9), and whether anything is unresolved is the dot on the `⋯` button (A5).
 * Computing them together is what keeps the dot from disagreeing with the
 * group it stands for.
 *
 * Body order leaves one case open, and the design's own transition table is
 * what opens it: a thread whose text was deleted stays in the unresolved
 * group (§9.2), and it has no position to sort by. They go last, oldest
 * first — sorting them among the others would need a position they do not
 * have, and any stand-in would make the list jump at the moment a peer
 * deletes the text.
 *
 * An orphan counts as unresolved for the dot, for the same reason it stays in
 * that group: the reader has not dealt with it yet.
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

  it('keeps a thread whose text was deleted in the unresolved group', () => {
    const rail = commentRail([thread('orphan', 1)], at());
    expect(ids(rail.unresolved)).toEqual(['orphan']);
    expect(rail.unresolved[0]!.settled).toBe(false);
  });

  it('sends a resolved thread whose text was deleted to the resolved group', () => {
    const rail = commentRail([thread('both', 1, true)], at());
    expect(ids(rail.resolved)).toEqual(['both']);
    expect(rail.resolved[0]!.settled).toBe(true);
  });

  it('puts the ones with no text left after the ones that have it', () => {
    const rail = commentRail(
      [thread('orphan', 1), thread('placed', 2)],
      at(['placed', 90]),
    );
    expect(ids(rail.unresolved)).toEqual(['placed', 'orphan']);
  });

  it('orders the ones with no text left by age', () => {
    const rail = commentRail([thread('newer', 2), thread('older', 1)], at());
    expect(ids(rail.unresolved)).toEqual(['older', 'newer']);
  });

  it('leaves something in the first group while anything is unresolved', () => {
    // The dot on the `⋯` button is this group's length, counted where it is
    // drawn (`DocumentEditor`), so this group is what the dot stands for.
    const rail = commentRail([thread('live', 1)], at(['live', 10]));
    expect(rail.unresolved).toHaveLength(1);
  });

  it('keeps an orphan in it too, which nobody has dealt with', () => {
    const rail = commentRail([thread('orphan', 1)], at());
    expect(rail.unresolved).toHaveLength(1);
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
      [
        thread('resolved-orphan', 1, true),
        thread('late', 2, true),
        thread('early', 3, true),
      ],
      at(['late', 90], ['early', 10]),
    );
    expect(ids(rail.resolved)).toEqual(['early', 'late', 'resolved-orphan']);
  });
});
