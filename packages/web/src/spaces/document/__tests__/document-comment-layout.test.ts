// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where each card sits down the panel (#18, user 2026-09-22).
 *
 * A card belongs beside the words it is about, so the two columns read
 * across: a run commented halfway down the body has its card halfway down the
 * panel, and the gaps between cards are the stretches nobody commented on.
 *
 * Cards are taller than the runs they point at, so two comments a line apart
 * cannot both sit at their anchor. The one being read wins — it keeps its
 * anchor and the others give way around it, which is what CKEditor's sidebar
 * and the anchored threads in Elves both do. With nothing being read, the
 * first card keeps its anchor and the rest give way downwards.
 *
 * The geometry itself comes from the browser; this is the part that decides
 * what to do with it, and it is where every rule about crowding lives.
 */

import { describe, it, expect } from 'vitest';

import { layOutCards } from '@web/spaces/document/document-comment-layout';

/** The gap this Space keeps between two cards. */
const GAP = 8;

describe('layOutCards', () => {
  it('leaves a card at its anchor when nothing crowds it', () => {
    const placed = layOutCards(
      [
        { id: 'a', anchor: 0, height: 100 },
        { id: 'b', anchor: 400, height: 100 },
      ],
      null,
      GAP,
    );
    expect(placed.get('a')).toBe(0);
    expect(placed.get('b')).toBe(400);
  });

  it('pushes the second card down when the two would overlap', () => {
    const placed = layOutCards(
      [
        { id: 'a', anchor: 0, height: 100 },
        { id: 'b', anchor: 20, height: 100 },
      ],
      null,
      GAP,
    );
    expect(placed.get('a')).toBe(0);
    expect(placed.get('b')).toBe(108);
  });

  it('keeps pushing down a run of crowded cards', () => {
    const placed = layOutCards(
      [
        { id: 'a', anchor: 0, height: 50 },
        { id: 'b', anchor: 10, height: 50 },
        { id: 'c', anchor: 20, height: 50 },
      ],
      null,
      GAP,
    );
    expect([placed.get('a'), placed.get('b'), placed.get('c')]).toEqual([
      0, 58, 116,
    ]);
  });

  it('gives the card being read its own anchor', () => {
    // Three cards that would crowd. `b` is the one the reader opened, so it
    // sits where its words are and the others move out of its way.
    const placed = layOutCards(
      [
        { id: 'a', anchor: 0, height: 100 },
        { id: 'b', anchor: 40, height: 100 },
        { id: 'c', anchor: 80, height: 100 },
      ],
      'b',
      GAP,
    );
    expect(placed.get('b')).toBe(40);
  });

  it('moves the cards above the one being read upwards', () => {
    const placed = layOutCards(
      [
        { id: 'a', anchor: 0, height: 100 },
        { id: 'b', anchor: 40, height: 100 },
      ],
      'b',
      GAP,
    );
    // `a` would run into `b` at its own anchor, so it ends above it.
    expect(placed.get('a')).toBe(40 - GAP - 100);
  });

  it('moves the cards below the one being read downwards', () => {
    const placed = layOutCards(
      [
        { id: 'a', anchor: 40, height: 100 },
        { id: 'b', anchor: 80, height: 100 },
      ],
      'a',
      GAP,
    );
    expect(placed.get('a')).toBe(40);
    expect(placed.get('b')).toBe(148);
  });

  it('leaves a card above the one being read where it is when it fits', () => {
    const placed = layOutCards(
      [
        { id: 'a', anchor: 0, height: 100 },
        { id: 'b', anchor: 400, height: 100 },
      ],
      'b',
      GAP,
    );
    expect(placed.get('a')).toBe(0);
  });

  it('reads the cards in anchor order, whatever order they arrive in', () => {
    const placed = layOutCards(
      [
        { id: 'later', anchor: 400, height: 100 },
        { id: 'earlier', anchor: 0, height: 100 },
      ],
      null,
      GAP,
    );
    expect(placed.get('earlier')).toBe(0);
    expect(placed.get('later')).toBe(400);
  });

  it('answers nothing for no cards', () => {
    expect(layOutCards([], null, GAP).size).toBe(0);
  });

  it('ignores a card being named that it was not given', () => {
    const placed = layOutCards([{ id: 'a', anchor: 0, height: 100 }], 'gone', GAP);
    expect(placed.get('a')).toBe(0);
  });
});
