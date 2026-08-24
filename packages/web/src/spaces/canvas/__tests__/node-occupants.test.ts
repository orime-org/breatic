// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, expect, it } from 'vitest';

import { collectNodeOccupants } from '@web/spaces/canvas/node-occupants';

/**
 * Build the awareness state map the way `getStates()` hands it over.
 * @param entries - Client id paired with the user id and holding it published.
 * @returns A states map shaped like the protocol's.
 */
function states(
  entries: Array<[number, { userId?: string; activeNodeIds?: string[] | null }]>,
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
    const occupants = collectNodeOccupants(
      states([[2, { userId: 'alice', activeNodeIds: ['n1'] }]]),
      1,
    );

    expect(occupants.get('n1')).toEqual(['alice']);
  });

  it('lists every node one user holds', () => {
    const occupants = collectNodeOccupants(
      states([[2, { userId: 'alice', activeNodeIds: ['n1', 'n2'] }]]),
      1,
    );

    expect(occupants.get('n1')).toEqual(['alice']);
    expect(occupants.get('n2')).toEqual(['alice']);
  });

  it('lists every user holding the same node', () => {
    const occupants = collectNodeOccupants(
      states([
        [2, { userId: 'alice', activeNodeIds: ['n1'] }],
        [3, { userId: 'bob', activeNodeIds: ['n1'] }],
      ]),
      1,
    );

    expect(occupants.get('n1')).toEqual(['alice', 'bob']);
  });

  it('counts one person once when they have two tabs on the same node', () => {
    // Same account, two browser tabs: two client ids, one person to show.
    const occupants = collectNodeOccupants(
      states([
        [2, { userId: 'alice', activeNodeIds: ['n1'] }],
        [3, { userId: 'alice', activeNodeIds: ['n1'] }],
      ]),
      1,
    );

    expect(occupants.get('n1')).toEqual(['alice']);
  });

  it('leaves this client out of its own view', () => {
    const occupants = collectNodeOccupants(
      states([[1, { userId: 'me', activeNodeIds: ['n1'] }]]),
      1,
    );

    expect(occupants.size).toBe(0);
  });

  it('leaves out a client that holds nothing', () => {
    const occupants = collectNodeOccupants(
      states([
        [2, { userId: 'alice', activeNodeIds: null }],
        [3, { userId: 'bob' }],
      ]),
      1,
    );

    expect(occupants.size).toBe(0);
  });

  it('ignores a client the server never stamped', () => {
    // Every accepted connection gets a `user.id` written by the server, so a
    // state without one is not something to render a name for.
    const occupants = collectNodeOccupants(
      states([[2, { activeNodeIds: ['n1'] }]]),
      1,
    );

    expect(occupants.size).toBe(0);
  });

  it('ignores entries that are not a list of ids', () => {
    const hostile = new Map<number, Record<string, unknown>>([
      [2, { user: { id: 'alice' }, activeNodeIds: 'n1' }],
      [3, { user: { id: 'bob' }, activeNodeIds: [7, { n: 1 }] }],
    ]);

    const occupants = collectNodeOccupants(hostile, 1);

    expect(occupants.size).toBe(0);
  });
});
