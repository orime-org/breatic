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

import {
  inColumnOrder,
  layOutCards,
} from '@web/spaces/document/document-comment-layout';

/** The gap this Space keeps between two cards. */
const GAP = 8;

/** How close to the panel's header a card may come. */
const MIN_TOP = 4;

describe('layOutCards', () => {
  it('leaves a card at its anchor when nothing crowds it', () => {
    const placed = layOutCards(
      [
        { id: 'a', anchor: 40, height: 100 },
        { id: 'b', anchor: 400, height: 100 },
      ],
      null,
      GAP,
      MIN_TOP,
    );
    expect(placed.get('a')).toBe(40);
    expect(placed.get('b')).toBe(400);
  });

  it('pushes the second card down when the two would overlap', () => {
    const placed = layOutCards(
      [
        { id: 'a', anchor: 40, height: 100 },
        { id: 'b', anchor: 60, height: 100 },
      ],
      null,
      GAP,
      MIN_TOP,
    );
    expect(placed.get('a')).toBe(40);
    expect(placed.get('b')).toBe(148);
  });

  it('keeps pushing down a run of crowded cards', () => {
    const placed = layOutCards(
      [
        { id: 'a', anchor: 40, height: 50 },
        { id: 'b', anchor: 50, height: 50 },
        { id: 'c', anchor: 60, height: 50 },
      ],
      null,
      GAP,
      MIN_TOP,
    );
    expect([placed.get('a'), placed.get('b'), placed.get('c')]).toEqual([
      40, 98, 156,
    ]);
  });

  it('gives the card being read its own anchor', () => {
    // Three cards that would crowd. `b` is the one the reader opened, so it
    // sits where its words are and the others move out of its way.
    const placed = layOutCards(
      [
        { id: 'a', anchor: 200, height: 100 },
        { id: 'b', anchor: 240, height: 100 },
        { id: 'c', anchor: 280, height: 100 },
      ],
      'b',
      GAP,
      MIN_TOP,
    );
    expect(placed.get('b')).toBe(240);
  });

  it('moves the cards above the one being read upwards', () => {
    const placed = layOutCards(
      [
        { id: 'a', anchor: 200, height: 100 },
        { id: 'b', anchor: 240, height: 100 },
      ],
      'b',
      GAP,
      MIN_TOP,
    );
    // `a` would run into `b` at its own anchor, so it ends above it.
    expect(placed.get('a')).toBe(240 - GAP - 100);
  });

  it('moves the cards below the one being read downwards', () => {
    const placed = layOutCards(
      [
        { id: 'a', anchor: 40, height: 100 },
        { id: 'b', anchor: 80, height: 100 },
      ],
      'a',
      GAP,
      MIN_TOP,
    );
    expect(placed.get('a')).toBe(40);
    expect(placed.get('b')).toBe(148);
  });

  it('leaves a card above the one being read where it is when it fits', () => {
    const placed = layOutCards(
      [
        { id: 'a', anchor: 40, height: 100 },
        { id: 'b', anchor: 400, height: 100 },
      ],
      'b',
      GAP,
      MIN_TOP,
    );
    expect(placed.get('a')).toBe(40);
  });

  it('reads the cards in anchor order, whatever order they arrive in', () => {
    const placed = layOutCards(
      [
        { id: 'later', anchor: 400, height: 100 },
        { id: 'earlier', anchor: 40, height: 100 },
      ],
      null,
      GAP,
      MIN_TOP,
    );
    expect(placed.get('earlier')).toBe(40);
    expect(placed.get('later')).toBe(400);
  });

  it('answers nothing for no cards', () => {
    expect(layOutCards([], null, GAP, MIN_TOP).size).toBe(0);
  });

  it('ignores a card being named that it was not given', () => {
    const placed = layOutCards(
      [{ id: 'a', anchor: 40, height: 100 }],
      'gone',
      GAP,
      MIN_TOP,
    );
    expect(placed.get('a')).toBe(40);
  });
});

describe('a card with no words left', () => {
  // A thread whose run was deleted has no mark to measure, so it arrives
  // without an anchor. It still has to sit somewhere, and the one place that
  // is not on top of another card is below the last one that does have words.
  it('sits below every card that still has an anchor', () => {
    const placed = layOutCards(
      [
        { id: 'a', anchor: 40, height: 100 },
        { id: 'b', anchor: 300, height: 100 },
        { id: 'gone', anchor: null, height: 80 },
      ],
      null,
      GAP,
      MIN_TOP,
    );
    expect(placed.get('gone')).toBe(300 + 100 + GAP);
  });

  it('stacks two of them below one another', () => {
    const placed = layOutCards(
      [
        { id: 'a', anchor: 40, height: 100 },
        { id: 'gone1', anchor: null, height: 80 },
        { id: 'gone2', anchor: null, height: 60 },
      ],
      null,
      GAP,
      MIN_TOP,
    );
    expect(placed.get('gone1')).toBe(40 + 100 + GAP);
    expect(placed.get('gone2')).toBe(40 + 100 + GAP + 80 + GAP);
  });

  it('starts them at the top when no card has an anchor at all', () => {
    const placed = layOutCards(
      [{ id: 'gone', anchor: null, height: 80 }],
      null,
      GAP,
      MIN_TOP,
    );
    expect(placed.get('gone')).toBe(MIN_TOP);
  });
});

describe('the panel header', () => {
  it('holds a card back from it when its words are that high up', () => {
    // The first line of the body sits level with the top of the column, and
    // a card level with THAT would touch the header.
    const placed = layOutCards(
      [{ id: 'a', anchor: 0, height: 100 }],
      null,
      GAP,
      MIN_TOP,
    );
    expect(placed.get('a')).toBe(MIN_TOP);
  });

  it('stacks down from it rather than letting a card give way over it', () => {
    // `b` is being read, so `a` gives way upwards — and there is nowhere up
    // there to go. Both come down from the header instead, which takes `b`
    // off its anchor: near the top of the body that is the only place left.
    const placed = layOutCards(
      [
        { id: 'a', anchor: 0, height: 100 },
        { id: 'b', anchor: 40, height: 100 },
      ],
      'b',
      GAP,
      MIN_TOP,
    );
    expect(placed.get('a')).toBe(MIN_TOP);
    expect(placed.get('b')).toBe(MIN_TOP + 100 + GAP);
  });
});

describe('the order the cards are written in', () => {
  it('follows the column rather than the panel\'s two groups', () => {
    // The panel reads every unresolved thread before every settled one,
    // while the column mixes them by where their words are. Tab order is DOM
    // order, so the writing order has to come from the placement or the
    // keyboard walks the panel in an order nobody can see.
    const placed = new Map([
      ['settled-early', 20],
      ['open-late', 300],
    ]);

    const written = inColumnOrder(
      [{ id: 'open-late' }, { id: 'settled-early' }],
      placed,
    );

    expect(written.map((card) => card.id)).toEqual([
      'settled-early',
      'open-late',
    ]);
  });
});
