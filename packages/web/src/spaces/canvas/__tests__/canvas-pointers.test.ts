// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it, vi } from 'vitest';

import { collectPointers, samePointers, toCanvasPoint } from '@web/spaces/canvas/canvas-pointers';

interface Published {
  userId?: string;
  pointer?: { x: number; y: number } | null;
}

/**
 * Build the awareness state map the way `getStates()` hands it over.
 * @param entries - Client id paired with what that client published.
 * @returns A states map shaped like the protocol's.
 */
function states(
  entries: Array<[number, Published]>,
): Map<number, Record<string, unknown>> {
  return new Map(
    entries.map(([clientId, { userId, pointer }]) => [
      clientId,
      {
        ...(userId === undefined ? {} : { user: { id: userId } }),
        ...(pointer === undefined ? {} : { pointer }),
      },
    ]),
  );
}

describe('collectPointers', () => {
  it('reads a peer pointer', () => {
    const found = collectPointers(states([[2, { userId: 'alice', pointer: { x: 10, y: 20 } }]]), 1);

    expect(found).toEqual([{ clientId: 2, userId: 'alice', x: 10, y: 20 }]);
  });

  it('leaves this client out of its own view', () => {
    const found = collectPointers(states([[1, { userId: 'me', pointer: { x: 1, y: 2 } }]]), 1);

    expect(found).toEqual([]);
  });

  it('leaves out a peer whose pointer is away', () => {
    const found = collectPointers(
      states([
        [2, { userId: 'alice', pointer: null }],
        [3, { userId: 'bob' }],
      ]),
      1,
    );

    expect(found).toEqual([]);
  });

  it('ignores a client the server never stamped', () => {
    const found = collectPointers(states([[2, { pointer: { x: 1, y: 2 } }]]), 1);

    expect(found).toEqual([]);
  });

  it('draws one arrow per connection, not per person', () => {
    // The same account in two tabs really does have two pointers in two
    // places; picking one of them to show would make the arrow jump.
    const found = collectPointers(
      states([
        [2, { userId: 'alice', pointer: { x: 10, y: 20 } }],
        [3, { userId: 'alice', pointer: { x: 90, y: 80 } }],
      ]),
      1,
    );

    expect(found).toEqual([
      { clientId: 2, userId: 'alice', x: 10, y: 20 },
      { clientId: 3, userId: 'alice', x: 90, y: 80 },
    ]);
  });

  it('ignores a pointer that is not a pair of numbers', () => {
    const hostile = new Map<number, Record<string, unknown>>([
      [2, { user: { id: 'a' }, pointer: { x: '10', y: 20 } }],
      [3, { user: { id: 'b' }, pointer: [10, 20] }],
      [4, { user: { id: 'c' }, pointer: { x: 10 } }],
      [5, { user: { id: 'd' }, pointer: 'far away' }],
      [6, { user: { id: 'e' }, pointer: { x: Number.NaN, y: 0 } }],
    ]);

    expect(collectPointers(hostile, 1)).toEqual([]);
  });
});

describe('toCanvasPoint', () => {
  it('turns snapping off explicitly', () => {
    // `screenToFlowPosition` falls back to the store's `snapToGrid` when the
    // option is absent, and the viewport toolbar's snap switch feeds that flag.
    // With it on, every published pointer would quantise to SNAP_GRID — up to
    // half a grid step away from where the person is actually pointing.
    const convert = vi.fn(() => ({ x: 0, y: 0 }));

    toCanvasPoint(convert, { x: 40, y: 60 });

    expect(convert).toHaveBeenCalledWith({ x: 40, y: 60 }, { snapToGrid: false });
  });
});

describe('samePointers', () => {
  // This comparison is the only gate between an awareness change and a redraw
  // of the arrows, so every field it reads has to be able to fail the test.
  const alice = { clientId: 2, userId: 'u1', x: 5, y: 6 };

  it('holds two identical lists equal', () => {
    expect(samePointers([alice], [{ ...alice }])).toBe(true);
  });

  it('sees a move along y alone', () => {
    expect(samePointers([alice], [{ ...alice, y: 7 }])).toBe(false);
  });

  it('sees a move along x alone', () => {
    expect(samePointers([alice], [{ ...alice, x: 6 }])).toBe(false);
  });

  it('sees the same spot taken by a different person', () => {
    expect(samePointers([alice], [{ ...alice, userId: 'u2' }])).toBe(false);
  });

  it('sees the same person arriving on a different connection', () => {
    expect(samePointers([alice], [{ ...alice, clientId: 3 }])).toBe(false);
  });

  it('sees somebody joining or leaving', () => {
    expect(samePointers([alice], [])).toBe(false);
    expect(samePointers([], [alice])).toBe(false);
  });
});
