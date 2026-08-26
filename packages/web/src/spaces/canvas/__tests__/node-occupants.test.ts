// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';

import { collectNodeOccupants, sameOccupantTable } from '@web/spaces/canvas/node-occupants';

interface Published {
  userId?: string;
  activeNodeIds?: string[] | null;
}

/**
 * Build the awareness state map the way `getStates()` hands it over.
 * @param entries - Client id paired with the user id and holding it published.
 * @returns A states map shaped like the protocol's.
 */
function states(
  entries: Array<[number, Published]>,
): Map<number, Record<string, unknown>> {
  return new Map(
    entries.map(([clientId, { userId, activeNodeIds }]) => [
      clientId,
      {
        ...(userId === undefined ? {} : { user: { id: userId } }),
        ...(activeNodeIds === undefined ? {} : { activeNodeIds }),
      },
    ]),
  );
}

describe('collectNodeOccupants', () => {
  it('maps a held node to the user holding it', () => {
    const byNode = collectNodeOccupants(
      states([[2, { userId: 'alice', activeNodeIds: ['n1'] }]]),
      1,
    );

    expect(byNode.get('n1')).toEqual(['alice']);
  });

  it('lists every node one user holds', () => {
    const byNode = collectNodeOccupants(
      states([[2, { userId: 'alice', activeNodeIds: ['n1', 'n2'] }]]),
      1,
    );

    expect(byNode.get('n1')).toEqual(['alice']);
    expect(byNode.get('n2')).toEqual(['alice']);
  });

  it('lists every user holding the same node', () => {
    const byNode = collectNodeOccupants(
      states([
        [2, { userId: 'alice', activeNodeIds: ['n1'] }],
        [3, { userId: 'bob', activeNodeIds: ['n1'] }],
      ]),
      1,
    );

    expect(byNode.get('n1')).toEqual(['alice', 'bob']);
  });

  it('lists them in the same order however the states arrive', () => {
    // The row draws two names and counts the rest, so the order decides who is
    // seen. Awareness hands its table back in insertion order, and a peer that
    // times out and comes back is re-inserted at the end — which would reshuffle
    // who is named on a node that peer has nothing to do with.
    const held = (order: Array<[number, Published]>): string[] | undefined =>
      collectNodeOccupants(states(order), 1).get('n1');

    const arrivals: Array<[number, Published]> = [
      [2, { userId: 'carol', activeNodeIds: ['n1'] }],
      [3, { userId: 'alice', activeNodeIds: ['n1'] }],
      [4, { userId: 'bob', activeNodeIds: ['n1'] }],
    ];

    expect(held(arrivals)).toEqual(['alice', 'bob', 'carol']);
    expect(held([...arrivals].reverse())).toEqual(['alice', 'bob', 'carol']);
  });

  it('counts one person once when they have two tabs on the same node', () => {
    // Same account, two browser tabs: two client ids, one person to show.
    const byNode = collectNodeOccupants(
      states([
        [2, { userId: 'alice', activeNodeIds: ['n1'] }],
        [3, { userId: 'alice', activeNodeIds: ['n1'] }],
      ]),
      1,
    );

    expect(byNode.get('n1')).toEqual(['alice']);
  });

  it('leaves this client out of its own view', () => {
    const byNode = collectNodeOccupants(
      states([[1, { userId: 'me', activeNodeIds: ['n1'] }]]),
      1,
    );

    expect(byNode.size).toBe(0);
  });

  it('leaves out a client that holds nothing', () => {
    const byNode = collectNodeOccupants(
      states([
        [2, { userId: 'alice', activeNodeIds: null }],
        [3, { userId: 'bob' }],
      ]),
      1,
    );

    expect(byNode.size).toBe(0);
  });

  it('ignores a client the server never stamped', () => {
    // Every accepted connection gets a `user.id` written by the server, so a
    // state without one is not something to render a name for.
    const byNode = collectNodeOccupants(states([[2, { activeNodeIds: ['n1'] }]]), 1);

    expect(byNode.size).toBe(0);
  });

  it('ignores entries that are not a list of ids', () => {
    const hostile = new Map<number, Record<string, unknown>>([
      [2, { user: { id: 'alice' }, activeNodeIds: 'n1' }],
      [3, { user: { id: 'bob' }, activeNodeIds: [7, { n: 1 }] }],
    ]);

    const byNode = collectNodeOccupants(hostile, 1);

    expect(byNode.size).toBe(0);
  });
});

describe('sameOccupantTable', () => {
  /**
   * Build an occupant table from plain pairs.
   * @param pairs - Key paired with the user ids holding it.
   * @returns The table.
   */
  function table(pairs: Array<[string, string[]]>): Map<string, string[]> {
    return new Map(pairs);
  }

  it('calls two empty tables the same', () => {
    expect(sameOccupantTable(table([]), table([]))).toBe(true);
  });

  it('calls tables with equal contents the same', () => {
    expect(
      sameOccupantTable(
        table([
          ['n1', ['alice']],
          ['n2', ['bob', 'carol']],
        ]),
        table([
          ['n1', ['alice']],
          ['n2', ['bob', 'carol']],
        ]),
      ),
    ).toBe(true);
  });

  it('sees a key appear', () => {
    expect(sameOccupantTable(table([]), table([['n1', ['alice']]]))).toBe(false);
  });

  it('sees a key disappear', () => {
    expect(sameOccupantTable(table([['n1', ['alice']]]), table([]))).toBe(false);
  });

  it('sees the same count of keys under different names', () => {
    // Two people swapping which node they hold keeps the size at one.
    expect(sameOccupantTable(table([['n1', ['alice']]]), table([['n2', ['alice']]]))).toBe(
      false,
    );
  });

  it('sees a holder join a key', () => {
    expect(
      sameOccupantTable(table([['n1', ['alice']]]), table([['n1', ['alice', 'bob']]])),
    ).toBe(false);
  });

  it('sees a holder replaced by another', () => {
    expect(sameOccupantTable(table([['n1', ['alice']]]), table([['n1', ['bob']]]))).toBe(
      false,
    );
  });

  it('sees the holders reordered', () => {
    // Order decides the order the name tags are laid out in, so it is part of
    // what the renderer draws, not an implementation detail to look past.
    expect(
      sameOccupantTable(table([['n1', ['alice', 'bob']]]), table([['n1', ['bob', 'alice']]])),
    ).toBe(false);
  });
});
