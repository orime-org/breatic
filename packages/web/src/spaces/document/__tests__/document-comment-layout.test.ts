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
  hiddenAbove,
  inColumnOrder,
  layOutCards,
  liftToReveal,
  nextLift,
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
    expect(placed.tops.get('a')).toBe(40);
    expect(placed.tops.get('b')).toBe(400);
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
    expect(placed.tops.get('a')).toBe(40);
    expect(placed.tops.get('b')).toBe(148);
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
    expect([placed.tops.get('a'), placed.tops.get('b'), placed.tops.get('c')]).toEqual([
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
    expect(placed.tops.get('b')).toBe(240);
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
    expect(placed.tops.get('a')).toBe(240 - GAP - 100);
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
    expect(placed.tops.get('a')).toBe(40);
    expect(placed.tops.get('b')).toBe(148);
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
    expect(placed.tops.get('a')).toBe(40);
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
    expect(placed.tops.get('earlier')).toBe(40);
    expect(placed.tops.get('later')).toBe(400);
  });

  it('answers nothing for no cards', () => {
    expect(layOutCards([], null, GAP, MIN_TOP).tops.size).toBe(0);
  });

  it('ignores a card being named that it was not given', () => {
    const placed = layOutCards(
      [{ id: 'a', anchor: 40, height: 100 }],
      'gone',
      GAP,
      MIN_TOP,
    );
    expect(placed.tops.get('a')).toBe(40);
  });
});

describe('a card with no anchor', () => {
  // A card whose words are not measured yet, or a draft whose words are
  // gone, arrives without an anchor. It still has to sit somewhere, and the
  // one place that is not on top of another card is below the last one that
  // does have one.
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
    expect(placed.tops.get('gone')).toBe(300 + 100 + GAP);
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
    expect(placed.tops.get('gone1')).toBe(40 + 100 + GAP);
    expect(placed.tops.get('gone2')).toBe(40 + 100 + GAP + 80 + GAP);
  });

  it('starts them at the top when no card has an anchor at all', () => {
    const placed = layOutCards(
      [{ id: 'gone', anchor: null, height: 80 }],
      null,
      GAP,
      MIN_TOP,
    );
    expect(placed.tops.get('gone')).toBe(MIN_TOP);
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
    expect(placed.tops.get('a')).toBe(MIN_TOP);
  });

  it('keeps the card being read on its words and lets the ones above pass under it', () => {
    // user 2026-09-24: the card being read stays level with its words, and a
    // card above it with no room left goes up under the header. The panel's
    // own scroll brings it back.
    const placed = layOutCards(
      [
        { id: 'a', anchor: 0, height: 100 },
        { id: 'b', anchor: 40, height: 100 },
      ],
      'b',
      GAP,
      MIN_TOP,
    );
    expect(placed.tops.get('b')).toBe(40);
    expect(placed.tops.get('a')).toBe(40 - GAP - 100);
  });

  it('holds the card being read itself back from it', () => {
    // Covering the header would leave the reader unable to see all of the one
    // card they are reading; below it is the only place left.
    const placed = layOutCards(
      [
        { id: 'a', anchor: 0, height: 100 },
        { id: 'b', anchor: 40, height: 100 },
      ],
      'a',
      GAP,
      MIN_TOP,
    );
    expect(placed.tops.get('a')).toBe(MIN_TOP);
    expect(placed.tops.get('b')).toBe(MIN_TOP + 100 + GAP);
  });
});

describe('how far the cards above the one being read were pushed', () => {
  it('is how far the one pushed furthest is from its words', () => {
    const placed = layOutCards(
      [
        { id: 'a', anchor: 0, height: 100 },
        { id: 'b', anchor: 10, height: 100 },
        { id: 'c', anchor: 40, height: 100 },
      ],
      'c',
      GAP,
      MIN_TOP,
    );
    // b sits at 40 - 8 - 100 = -68, a at -68 - 8 - 100 = -176.
    expect(placed.raised).toBe(176);
  });

  it('is nothing when the cards above had room', () => {
    const placed = layOutCards(
      [
        { id: 'a', anchor: 40, height: 100 },
        { id: 'b', anchor: 400, height: 100 },
      ],
      'b',
      GAP,
      MIN_TOP,
    );
    expect(placed.raised).toBe(0);
  });

  it('is nothing when no card is being read', () => {
    const placed = layOutCards(
      [
        { id: 'a', anchor: 0, height: 100 },
        { id: 'b', anchor: 40, height: 100 },
      ],
      null,
      GAP,
      MIN_TOP,
    );
    expect(placed.raised).toBe(0);
  });
});

describe('which cards the one being read pushed up', () => {
  it('names the cards above it that sit above their words', () => {
    const placed = layOutCards(
      [
        { id: 'far', anchor: -500, height: 100 },
        { id: 'a', anchor: 0, height: 100 },
        { id: 'b', anchor: 10, height: 100 },
        { id: 'c', anchor: 40, height: 100 },
      ],
      'c',
      GAP,
      MIN_TOP,
    );
    // b at -68 and a at -176 were pushed; far had room at its own words.
    expect([...placed.pushed].sort()).toEqual(['a', 'b']);
  });

  it('names none when no card is being read', () => {
    const placed = layOutCards(
      [
        { id: 'a', anchor: 0, height: 100 },
        { id: 'b', anchor: 40, height: 100 },
      ],
      null,
      GAP,
      MIN_TOP,
    );
    expect(placed.pushed.size).toBe(0);
  });
});

describe('the order the cards are written in', () => {
  it('follows the column rather than the panel\'s two groups', () => {
    // The panel reads every unresolved thread before every settled one,
    // while the column mixes them by where their words are. Tab order is DOM
    // order, so the writing order comes from the placement or the keyboard
    // walks the panel in an order nobody can see.
    const placed = layOutCards(
      [
        { id: 'open-late', anchor: 300, height: 60 },
        { id: 'settled-early', anchor: 20, height: 60 },
      ],
      null,
      GAP,
      MIN_TOP,
    );

    const written = inColumnOrder(
      [{ id: 'open-late' }, { id: 'settled-early' }],
      placed.order,
    );

    expect(written.map((card) => card.id)).toEqual([
      'settled-early',
      'open-late',
    ]);
  });

  it('leaves out a card the placement never saw', () => {
    // The two readings are taken a render apart, so a thread deleted between
    // them is named by one and not the other.
    const written = inColumnOrder([{ id: 'a' }], ['a', 'gone']);

    expect(written.map((card) => card.id)).toEqual(['a']);
  });
});

describe('the panel lifting its own column', () => {
  // A wheel turn over the panel first brings back the cards hidden under the
  // header, then goes to the body (user 2026-09-24, design §9.6.1).
  const UP = -30;
  const DOWN = 30;

  it('lifts by the turn while a card is hidden and there is room', () => {
    expect(nextLift({ lift: 0, delta: UP, raised: 100, hidden: 80 })).toEqual({
      lift: 30,
      taken: true,
    });
  });

  it('stops at what is hidden', () => {
    expect(nextLift({ lift: 0, delta: -200, raised: 100, hidden: 50 })).toEqual({
      lift: 50,
      taken: true,
    });
  });

  it('stops at how far the cards were pushed', () => {
    expect(nextLift({ lift: 90, delta: UP, raised: 100, hidden: 80 })).toEqual({
      lift: 100,
      taken: true,
    });
  });

  it('hands the turn to the body once nothing is hidden', () => {
    expect(nextLift({ lift: 20, delta: UP, raised: 100, hidden: 0 })).toEqual({
      lift: 20,
      taken: false,
    });
  });

  it('hands the turn to the body once lifted all the way', () => {
    expect(nextLift({ lift: 100, delta: UP, raised: 100, hidden: 40 })).toEqual({
      lift: 100,
      taken: false,
    });
  });

  it('lowers first on a turn the other way', () => {
    expect(nextLift({ lift: 50, delta: DOWN, raised: 100, hidden: 0 })).toEqual({
      lift: 20,
      taken: true,
    });
  });

  it('lowers no further than where it started', () => {
    expect(nextLift({ lift: 10, delta: DOWN, raised: 100, hidden: 0 })).toEqual({
      lift: 0,
      taken: true,
    });
  });

  it('hands a turn down to the body when nothing is lifted', () => {
    expect(nextLift({ lift: 0, delta: DOWN, raised: 100, hidden: 0 })).toEqual({
      lift: 0,
      taken: false,
    });
  });

  it('never takes a turn when the cards were not pushed at all', () => {
    expect(nextLift({ lift: 0, delta: UP, raised: 0, hidden: 80 })).toEqual({
      lift: 0,
      taken: false,
    });
  });
});

describe('lifting the column to show a card the focus landed on', () => {
  // Tab reaches cards in column order, so the first stops are the ones the
  // card being read pushed up under the header (design §9.6.1).
  it('lifts by as much as the card is hidden', () => {
    expect(liftToReveal({ lift: 0, raised: 200, hidden: 80 })).toBe(80);
  });

  it('adds to what the column is lifted already', () => {
    expect(liftToReveal({ lift: 30, raised: 200, hidden: 50 })).toBe(80);
  });

  it('stops at how far the cards were pushed', () => {
    expect(liftToReveal({ lift: 150, raised: 200, hidden: 80 })).toBe(200);
  });

  it('leaves the column where it is for a card in view', () => {
    expect(liftToReveal({ lift: 40, raised: 200, hidden: 0 })).toBe(40);
    expect(liftToReveal({ lift: 40, raised: 200, hidden: -20 })).toBe(40);
  });
});

describe('how far a pushed card is hidden under the header', () => {
  // The cards slide to a new top, so what a card's own box says in the
  // middle of a slide is where it has got to, not where it is going. Both the
  // wheel and the focus ask where it is going, from the layout.
  const placement = layOutCards(
    [
      { id: 'a', anchor: 0, height: 100 },
      { id: 'b', anchor: 10, height: 100 },
    ],
    'b',
    GAP,
    MIN_TOP,
  );

  it('reads the card from the layout, lift included', () => {
    const top = placement.tops.get('a')!;
    expect(
      hiddenAbove(placement, 'a', { edge: 50, columnTop: 40, lift: 5 }),
    ).toBe(50 - (40 + top + 5));
  });

  it('is zero for a card the layout did not push', () => {
    expect(
      hiddenAbove(placement, 'b', { edge: 500, columnTop: 0, lift: 0 }),
    ).toBe(0);
  });

  it('is the most hidden of the pushed cards when asked about them all', () => {
    const tops = [...placement.pushed].map((id) => placement.tops.get(id)!);
    expect(
      hiddenAbove(placement, null, { edge: 50, columnTop: 40, lift: 0 }),
    ).toBe(Math.max(0, ...tops.map((top) => 50 - (40 + top))));
  });
});
