// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import {
  filterLockedDeletion,
  groupDeletionIds,
  lockBlockedDeletion,
  lockedGroupMemberIds,
  lockedNodeIds,
  selectionDeletionIds,
} from '@web/spaces/canvas/group-membership';

describe('filterLockedDeletion — locked structure (nodes + edges) survives delete', () => {
  const allNodes = [
    { id: 'g', type: 'group', data: { locked: true } },
    { id: 'm', type: 'text', parentId: 'g', data: {} },
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
      { id: 'g', type: 'group', data: {} },
      { id: 'm', type: 'text', parentId: 'g', data: {} },
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
  it('returns the members of locked Groups only (membership via parentId)', () => {
    const nodes = [
      { id: 'g1', type: 'group', data: { locked: true } },
      { id: 'g2', type: 'group', data: { locked: false } },
      { id: 'a', type: 'text', parentId: 'g1', data: {} },
      { id: 'b', type: 'text', parentId: 'g1', data: {} },
      { id: 'c', type: 'text', parentId: 'g2', data: {} },
    ];
    expect(lockedGroupMemberIds(nodes)).toEqual(new Set(['a', 'b']));
  });

  it('is empty when no Group is locked', () => {
    const nodes = [
      { id: 'g', type: 'group', data: {} },
      { id: 'a', type: 'text', parentId: 'g', data: {} },
    ];
    expect(lockedGroupMemberIds(nodes)).toEqual(new Set());
  });
});

describe('groupDeletionIds — deleting a group deletes the whole group', () => {
  it('a group deletes the frame PLUS every member (matched by parentId)', () => {
    // Bug 2: deleting a group must remove the frame AND its contents — not just
    // release the members (that is the separate ungroup action).
    const nodes = [
      { id: 'g', type: 'group' },
      { id: 'm1', type: 'text', parentId: 'g' },
      { id: 'm2', type: 'image', parentId: 'g' },
      { id: 'other', type: 'text' },
    ];
    expect(groupDeletionIds('g', nodes)).toEqual(new Set(['g', 'm1', 'm2']));
  });

  it('an empty group deletes just the frame', () => {
    const nodes = [{ id: 'g', type: 'group' }];
    expect(groupDeletionIds('g', nodes)).toEqual(new Set(['g']));
  });

  it('a plain node deletes only itself (no cascade)', () => {
    const nodes = [
      { id: 'g', type: 'group' },
      { id: 'm', type: 'text', parentId: 'g' },
      { id: 'n', type: 'text' },
    ];
    expect(groupDeletionIds('n', nodes)).toEqual(new Set(['n']));
  });
});

describe('selectionDeletionIds — cascade a multi-selection delete through groups', () => {
  const nodes = [
    { id: 'g', type: 'group' },
    { id: 'm1', type: 'text', parentId: 'g' },
    { id: 'm2', type: 'image', parentId: 'g' },
    { id: 'loose', type: 'text' },
    { id: 'other', type: 'text' },
  ];

  it('expands a selected Group to the Group + all its members', () => {
    expect(selectionDeletionIds(['g'], nodes)).toEqual(
      new Set(['g', 'm1', 'm2']),
    );
  });

  it('unions every selected target (loose node + a Group with members)', () => {
    expect(selectionDeletionIds(['loose', 'g'], nodes)).toEqual(
      new Set(['loose', 'g', 'm1', 'm2']),
    );
  });

  it('a selection of loose nodes is just those nodes', () => {
    expect(selectionDeletionIds(['loose', 'other'], nodes)).toEqual(
      new Set(['loose', 'other']),
    );
  });

  it('a member selected alongside its Group is not duplicated', () => {
    expect(selectionDeletionIds(['g', 'm1'], nodes)).toEqual(
      new Set(['g', 'm1', 'm2']),
    );
  });
});

describe('lockedNodeIds — frozen-by-lock set (no move, no delete)', () => {
  it('includes any locked node (standalone OR group itself) + members of locked groups', () => {
    const nodes = [
      { id: 'lockedNode', type: 'text', data: { locked: true } },
      { id: 'g', type: 'group', data: { locked: true } },
      { id: 'm', type: 'text', parentId: 'g', data: {} },
      { id: 'free', type: 'text', data: {} },
    ];
    // locked standalone node + the locked Group's OWN id (so the whole Group is
    // frozen in place) + the locked Group's member (via parentId).
    expect(lockedNodeIds(nodes)).toEqual(new Set(['lockedNode', 'g', 'm']));
  });

  it('is empty when nothing is locked', () => {
    const nodes = [
      { id: 'a', type: 'text', parentId: 'g', data: {} },
      { id: 'g', type: 'group', data: {} },
    ];
    expect(lockedNodeIds(nodes)).toEqual(new Set());
  });
});
