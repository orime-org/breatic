// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, expect, it } from 'vitest';

import { collectOccupants } from '@web/spaces/canvas/occupants';

interface Published {
  userId?: string;
  activeNodeIds?: string[] | null;
  activeEdgeIds?: string[] | null;
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
    entries.map(([clientId, { userId, activeNodeIds, activeEdgeIds }]) => [
      clientId,
      {
        ...(userId === undefined ? {} : { user: { id: userId } }),
        ...(activeNodeIds === undefined ? {} : { activeNodeIds }),
        ...(activeEdgeIds === undefined ? {} : { activeEdgeIds }),
      },
    ]),
  );
}

describe('collectOccupants, node table', () => {
  it('maps a held node to the user holding it', () => {
    const { byNode } = collectOccupants(
      states([[2, { userId: 'alice', activeNodeIds: ['n1'] }]]),
      1,
    );

    expect(byNode.get('n1')).toEqual(['alice']);
  });

  it('lists every node one user holds', () => {
    const { byNode } = collectOccupants(
      states([[2, { userId: 'alice', activeNodeIds: ['n1', 'n2'] }]]),
      1,
    );

    expect(byNode.get('n1')).toEqual(['alice']);
    expect(byNode.get('n2')).toEqual(['alice']);
  });

  it('lists every user holding the same node', () => {
    const { byNode } = collectOccupants(
      states([
        [2, { userId: 'alice', activeNodeIds: ['n1'] }],
        [3, { userId: 'bob', activeNodeIds: ['n1'] }],
      ]),
      1,
    );

    expect(byNode.get('n1')).toEqual(['alice', 'bob']);
  });

  it('counts one person once when they have two tabs on the same node', () => {
    // Same account, two browser tabs: two client ids, one person to show.
    const { byNode } = collectOccupants(
      states([
        [2, { userId: 'alice', activeNodeIds: ['n1'] }],
        [3, { userId: 'alice', activeNodeIds: ['n1'] }],
      ]),
      1,
    );

    expect(byNode.get('n1')).toEqual(['alice']);
  });

  it('leaves this client out of its own view', () => {
    const { byNode } = collectOccupants(
      states([[1, { userId: 'me', activeNodeIds: ['n1'] }]]),
      1,
    );

    expect(byNode.size).toBe(0);
  });

  it('leaves out a client that holds no node', () => {
    const { byNode } = collectOccupants(
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
    const { byNode } = collectOccupants(states([[2, { activeNodeIds: ['n1'] }]]), 1);

    expect(byNode.size).toBe(0);
  });

  it('ignores entries that are not a list of ids', () => {
    const hostile = new Map<number, Record<string, unknown>>([
      [2, { user: { id: 'alice' }, activeNodeIds: 'n1' }],
      [3, { user: { id: 'bob' }, activeNodeIds: [7, { n: 1 }] }],
    ]);

    const { byNode } = collectOccupants(hostile, 1);

    expect(byNode.size).toBe(0);
  });
});

describe('collectOccupants, edge table', () => {
  it('maps a held edge to the user holding it', () => {
    const { byEdge } = collectOccupants(
      states([[2, { userId: 'alice', activeEdgeIds: ['e1'] }]]),
      1,
    );

    expect(byEdge.get('e1')).toEqual(['alice']);
  });

  it('lists every user holding the same edge, each once', () => {
    const { byEdge } = collectOccupants(
      states([
        [2, { userId: 'alice', activeEdgeIds: ['e1', 'e2'] }],
        [3, { userId: 'bob', activeEdgeIds: ['e1'] }],
        [4, { userId: 'alice', activeEdgeIds: ['e1'] }],
      ]),
      1,
    );

    expect(byEdge.get('e1')).toEqual(['alice', 'bob']);
    expect(byEdge.get('e2')).toEqual(['alice']);
  });

  it('leaves this client out of its own view', () => {
    const { byEdge } = collectOccupants(
      states([[1, { userId: 'me', activeEdgeIds: ['e1'] }]]),
      1,
    );

    expect(byEdge.size).toBe(0);
  });

  it('leaves out a client that holds no edge', () => {
    const { byEdge } = collectOccupants(
      states([
        [2, { userId: 'alice', activeEdgeIds: null }],
        [3, { userId: 'bob' }],
      ]),
      1,
    );

    expect(byEdge.size).toBe(0);
  });

  it('ignores entries that are not a list of ids', () => {
    const hostile = new Map<number, Record<string, unknown>>([
      [2, { user: { id: 'alice' }, activeEdgeIds: 'e1' }],
      [3, { user: { id: 'bob' }, activeEdgeIds: [7, { e: 1 }] }],
    ]);

    const { byEdge } = collectOccupants(hostile, 1);

    expect(byEdge.size).toBe(0);
  });

  it('ignores a client the server never stamped', () => {
    const { byEdge } = collectOccupants(states([[2, { activeEdgeIds: ['e1'] }]]), 1);

    expect(byEdge.size).toBe(0);
  });
});

describe('collectOccupants, the two tables together', () => {
  it('keeps the node holding out of the edge table and the other way round', () => {
    // The `focus` pick publishes nodes only; a click on a wire publishes edges
    // only. Both arrive on the same entry, and neither may leak into the other
    // table: an id is only ever looked up in the table its renderer owns.
    const { byNode, byEdge } = collectOccupants(
      states([[2, { userId: 'alice', activeNodeIds: ['n1'], activeEdgeIds: ['e1'] }]]),
      1,
    );

    expect([...byNode.keys()]).toEqual(['n1']);
    expect([...byEdge.keys()]).toEqual(['e1']);
  });

  it('still reads the node holding when the edge field is malformed', () => {
    // The two fields are validated apart: one peer publishing junk in one of
    // them must not blank out what it says about the other.
    const hostile = new Map<number, Record<string, unknown>>([
      [2, { user: { id: 'alice' }, activeNodeIds: ['n1'], activeEdgeIds: 'e1' }],
    ]);

    const { byNode, byEdge } = collectOccupants(hostile, 1);

    expect(byNode.get('n1')).toEqual(['alice']);
    expect(byEdge.size).toBe(0);
  });
});
