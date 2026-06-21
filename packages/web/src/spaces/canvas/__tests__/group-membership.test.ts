// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import {
  filterLockedDeletion,
  lockBlockedDeletion,
  lockedGroupMemberIds,
  lockedNodeIds,
  rectContains,
  resolveGroupDrop,
  type GroupBox,
} from '@web/spaces/canvas/group-membership';

const RECT = { x: 0, y: 0, width: 100, height: 100 };

describe('rectContains — point-in-rect', () => {
  it('is true for an interior point', () => {
    expect(rectContains(RECT, { x: 50, y: 50 })).toBe(true);
  });
  it('is true on the edge (inclusive)', () => {
    expect(rectContains(RECT, { x: 0, y: 100 })).toBe(true);
  });
  it('is false outside', () => {
    expect(rectContains(RECT, { x: 150, y: 50 })).toBe(false);
  });
});

/** A group at the unit rect with the given members. */
function box(id: string, childIds: string[], rect = RECT): GroupBox {
  return { id, rect, childIds };
}

describe('resolveGroupDrop — drag-end membership change', () => {
  it('adds a loose node dropped inside a group', () => {
    const groups = [box('g1', ['x'])];
    expect(resolveGroupDrop('n', { x: 50, y: 50 }, groups)).toEqual({
      action: 'add',
      groupId: 'g1',
    });
  });

  it('does nothing for a loose node dropped on empty canvas', () => {
    const groups = [box('g1', ['x'])];
    expect(resolveGroupDrop('n', { x: 999, y: 999 }, groups)).toEqual({
      action: 'none',
    });
  });

  it('removes a member dragged out of its group', () => {
    const groups = [box('g1', ['n', 'x'])];
    expect(resolveGroupDrop('n', { x: 999, y: 999 }, groups)).toEqual({
      action: 'remove',
      groupId: 'g1',
    });
  });

  it('does nothing when a member stays inside its own group', () => {
    const groups = [box('g1', ['n', 'x'])];
    expect(resolveGroupDrop('n', { x: 50, y: 50 }, groups)).toEqual({
      action: 'none',
    });
  });

  it('moves a member dropped into a different group (add to the new one)', () => {
    const groups = [
      box('g1', ['n'], { x: 0, y: 0, width: 100, height: 100 }),
      box('g2', ['y'], { x: 200, y: 0, width: 100, height: 100 }),
    ];
    expect(resolveGroupDrop('n', { x: 250, y: 50 }, groups)).toEqual({
      action: 'add',
      groupId: 'g2',
    });
  });

  it('does NOT add a node dropped into a LOCKED group (frozen membership)', () => {
    const groups: GroupBox[] = [
      { id: 'g1', rect: RECT, childIds: ['x'], locked: true },
    ];
    expect(resolveGroupDrop('n', { x: 50, y: 50 }, groups)).toEqual({
      action: 'none',
    });
  });

  it('does NOT remove a member dragged out of its own LOCKED group', () => {
    const groups: GroupBox[] = [
      { id: 'g1', rect: RECT, childIds: ['n', 'x'], locked: true },
    ];
    // n is a member of locked g1, dragged outside → must NOT leave.
    expect(resolveGroupDrop('n', { x: 999, y: 999 }, groups)).toEqual({
      action: 'none',
    });
  });
});

describe('filterLockedDeletion — locked structure (nodes + edges) survives delete', () => {
  const allNodes = [
    { id: 'g', type: 'group', data: { childIds: ['m'], locked: true } },
    { id: 'm', type: 'text', data: {} },
    { id: 'x', type: 'text', data: {} },
  ];

  it('keeps a locked group, its members, AND their edges out of the deletion', () => {
    const reqNodes = [{ id: 'g' }, { id: 'm' }, { id: 'x' }];
    const reqEdges = [
      { id: 'e1', source: 'm', target: 'x' }, // touches protected member m
      { id: 'e2', source: 'x', target: 'y' }, // safe (no protected endpoint)
    ];
    const out = filterLockedDeletion(reqNodes, reqEdges, allNodes);
    expect(out.nodes.map((n) => n.id)).toEqual(['x']); // g + m protected
    expect(out.edges.map((e) => e.id)).toEqual(['e2']); // e1 (→ m) protected
  });

  it('deletes freely when no group is locked', () => {
    const unlocked = [
      { id: 'g', type: 'group', data: { childIds: ['m'] } },
      { id: 'm', type: 'text', data: {} },
    ];
    const out = filterLockedDeletion(
      [{ id: 'g' }, { id: 'm' }],
      [{ id: 'e', source: 'm', target: 'm' }],
      unlocked,
    );
    expect(out.nodes.map((n) => n.id)).toEqual(['g', 'm']);
    expect(out.edges.map((e) => e.id)).toEqual(['e']);
  });

  it('keeps a locked STANDALONE node (not a group) AND its edges out of the deletion', () => {
    const nodes = [
      { id: 'a', type: 'text', data: { locked: true } },
      { id: 'b', type: 'text', data: {} },
    ];
    const out = filterLockedDeletion(
      [{ id: 'a' }, { id: 'b' }],
      [
        { id: 'e1', source: 'a', target: 'b' }, // touches locked a
        { id: 'e2', source: 'b', target: 'c' }, // safe (no locked endpoint)
      ],
      nodes,
    );
    expect(out.nodes.map((n) => n.id)).toEqual(['b']); // locked a protected
    expect(out.edges.map((e) => e.id)).toEqual(['e2']); // e1 (→ a) protected
  });
});

describe('lockBlockedDeletion — flags when a lock vetoed part of the deletion', () => {
  it('blocked=true; survivors exclude the locked node', () => {
    const allNodes = [
      { id: 'a', type: 'text', data: { locked: true } },
      { id: 'b', type: 'text', data: {} },
    ];
    const out = lockBlockedDeletion([{ id: 'a' }, { id: 'b' }], [], allNodes);
    expect(out.blocked).toBe(true);
    expect(out.survivors.nodes.map((n) => n.id)).toEqual(['b']);
  });

  it('blocked=false when nothing requested is locked', () => {
    const allNodes = [{ id: 'a', type: 'text', data: {} }];
    const out = lockBlockedDeletion([{ id: 'a' }], [], allNodes);
    expect(out.blocked).toBe(false);
    expect(out.survivors.nodes.map((n) => n.id)).toEqual(['a']);
  });

  it('blocked=true when a locked node protects an edge', () => {
    const allNodes = [{ id: 'a', type: 'text', data: { locked: true } }];
    const out = lockBlockedDeletion(
      [],
      [{ id: 'e1', source: 'a', target: 'b' }],
      allNodes,
    );
    expect(out.blocked).toBe(true);
    expect(out.survivors.edges).toHaveLength(0);
  });
});

describe('lockedGroupMemberIds — frozen member positions', () => {
  it('returns the members of locked groups only', () => {
    const nodes = [
      { id: 'g1', type: 'group', data: { childIds: ['a', 'b'], locked: true } },
      { id: 'g2', type: 'group', data: { childIds: ['c'], locked: false } },
      { id: 'a', type: 'text', data: {} },
    ];
    expect(lockedGroupMemberIds(nodes)).toEqual(new Set(['a', 'b']));
  });

  it('is empty when no group is locked', () => {
    const nodes = [{ id: 'g', type: 'group', data: { childIds: ['a'] } }];
    expect(lockedGroupMemberIds(nodes)).toEqual(new Set());
  });
});

describe('lockedNodeIds — frozen-by-lock set (no move, no delete)', () => {
  it('includes any locked node (standalone OR group itself) + members of locked groups', () => {
    const nodes = [
      { id: 'lockedNode', type: 'text', data: { locked: true } },
      { id: 'g', type: 'group', data: { childIds: ['m'], locked: true } },
      { id: 'm', type: 'text', data: {} },
      { id: 'free', type: 'text', data: {} },
    ];
    // locked standalone node + the locked group's OWN id (so the whole group is
    // frozen in place) + the locked group's member.
    expect(lockedNodeIds(nodes)).toEqual(new Set(['lockedNode', 'g', 'm']));
  });

  it('is empty when nothing is locked', () => {
    const nodes = [
      { id: 'a', type: 'text', data: {} },
      { id: 'g', type: 'group', data: { childIds: ['a'] } },
    ];
    expect(lockedNodeIds(nodes)).toEqual(new Set());
  });
});
