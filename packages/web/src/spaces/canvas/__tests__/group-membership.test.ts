// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import {
  filterGatedDeletion,
  gateBlockedDeletion,
  groupDeletionIds,
  handlingNodeIds,
  lockedGroupMemberIds,
  lockedNodeIds,
  selectionDeletionIds,
} from '@web/spaces/canvas/group-membership';

describe('filterGatedDeletion — locked + handling structure survives delete', () => {
  const allNodes = [
    { id: 'g', type: 'group', data: { locked: true } },
    { id: 'm', type: 'text', parentId: 'g', data: {} },
    { id: 'x', type: 'text', data: {} },
  ];

  it('keeps a locked group + members (nodes); edges follow endpoint survival, not membership', () => {
    // g + m are vetoed (a locked group + member); x is deleted. BOTH edges
    // touch the removed x, so both go — a group lock freezes member geometry /
    // existence, NOT the member's relations, and an edge to a REMOVED node must
    // never survive dangling (user 2026-07-20 edge model).
    const reqNodes = [{ id: 'g' }, { id: 'm' }, { id: 'x' }];
    const reqEdges = [
      { id: 'e1', source: 'm', target: 'x' }, // m vetoed but x removed → e1 goes
      { id: 'e2', source: 'x', target: 'y' }, // x removed → e2 goes
    ];
    const out = filterGatedDeletion(reqNodes, reqEdges, allNodes);
    expect(out.nodes.map((n) => n.id)).toEqual(['x']); // g + m vetoed
    expect(out.edges.map((e) => e.id)).toEqual(['e1', 'e2']); // both touch removed x
  });

  it('a vetoed node keeps its edge to a SURVIVING node (cascade veto, no dangling)', () => {
    // Deleting the locked group cascades m + m→x; g/m are vetoed and x survives
    // (not requested), so the edge stays with the kept member.
    const out = filterGatedDeletion(
      [{ id: 'g' }, { id: 'm' }],
      [{ id: 'e', source: 'm', target: 'x' }],
      allNodes,
    );
    expect(out.nodes).toHaveLength(0); // g + m vetoed
    expect(out.edges).toHaveLength(0); // e kept: m vetoed, x survives
  });

  it('deletes an explicit edge on a locked-group member (edges are relations, never lock-gated)', () => {
    // No node requested — just the edge m→x. m is a locked-group member, but a
    // group lock does not freeze relations, so the edge is freely deletable.
    const out = filterGatedDeletion(
      [],
      [{ id: 'e', source: 'm', target: 'x' }],
      allNodes,
    );
    expect(out.edges.map((e) => e.id)).toEqual(['e']); // deletable
  });

  it('deletes freely when no group is locked', () => {
    const unlocked = [
      { id: 'g', type: 'group', data: {} },
      { id: 'm', type: 'text', parentId: 'g', data: {} },
    ];
    const out = filterGatedDeletion(
      [{ id: 'g' }, { id: 'm' }],
      [{ id: 'e', source: 'm', target: 'm' }],
      unlocked,
    );
    expect(out.nodes.map((n) => n.id)).toEqual(['g', 'm']);
    expect(out.edges.map((e) => e.id)).toEqual(['e']);
  });

  it('keeps a locked STANDALONE node (node veto); its edges to REMOVED nodes still go', () => {
    const nodes = [
      { id: 'a', type: 'text', data: { locked: true } },
      { id: 'b', type: 'text', data: {} },
    ];
    const out = filterGatedDeletion(
      [{ id: 'a' }, { id: 'b' }],
      [
        { id: 'e1', source: 'a', target: 'b' }, // a vetoed but b removed → e1 goes
        { id: 'e2', source: 'b', target: 'c' }, // b removed → e2 goes
      ],
      nodes,
    );
    expect(out.nodes.map((n) => n.id)).toEqual(['b']); // locked a vetoed
    expect(out.edges.map((e) => e.id)).toEqual(['e1', 'e2']); // both touch removed b
  });

  it('deletes an explicit edge on an own-locked node (own lock does not gate relations)', () => {
    const nodes = [
      { id: 'a', type: 'text', data: { locked: true } },
      { id: 'b', type: 'text', data: {} },
    ];
    const out = filterGatedDeletion(
      [],
      [{ id: 'e', source: 'a', target: 'b' }],
      nodes,
    );
    expect(out.edges.map((e) => e.id)).toEqual(['e']); // deletable despite locked a
  });

  it('keeps a HANDLING node (node veto); its edges to REMOVED nodes still go', () => {
    const nodes = [
      { id: 'h', type: 'image', data: { status: 'handling' } },
      { id: 'b', type: 'text', data: {} },
    ];
    const out = filterGatedDeletion(
      [{ id: 'h' }, { id: 'b' }],
      [
        { id: 'e1', source: 'h', target: 'b' }, // h vetoed but b removed → e1 goes
        { id: 'e2', source: 'b', target: 'c' }, // b removed → e2 goes
      ],
      nodes,
    );
    expect(out.nodes.map((n) => n.id)).toEqual(['b']); // handling h vetoed
    expect(out.edges.map((e) => e.id)).toEqual(['e1', 'e2']); // both touch removed b
  });

  it('an idle (state absent / not handling) node deletes freely', () => {
    const nodes = [
      { id: 'a', type: 'text', data: { status: 'idle' } },
      { id: 'b', type: 'image', data: {} },
    ];
    const out = filterGatedDeletion([{ id: 'a' }, { id: 'b' }], [], nodes);
    expect(out.nodes.map((n) => n.id)).toEqual(['a', 'b']);
  });
});

describe('gateBlockedDeletion — flags when a gate vetoed part of the deletion + why', () => {
  it('locked node: blocked=true, reason=locked, survivors exclude it', () => {
    const allNodes = [
      { id: 'a', type: 'text', data: { locked: true } },
      { id: 'b', type: 'text', data: {} },
    ];
    const out = gateBlockedDeletion([{ id: 'a' }, { id: 'b' }], [], allNodes);
    expect(out.blocked).toBe(true);
    expect(out.reason).toBe('locked');
    expect(out.survivors.nodes.map((n) => n.id)).toEqual(['b']);
  });

  it('handling node: blocked=true, reason=handling, survivors exclude it', () => {
    const allNodes = [
      { id: 'h', type: 'image', data: { status: 'handling' } },
      { id: 'b', type: 'text', data: {} },
    ];
    const out = gateBlockedDeletion([{ id: 'h' }, { id: 'b' }], [], allNodes);
    expect(out.blocked).toBe(true);
    expect(out.reason).toBe('handling');
    expect(out.survivors.nodes.map((n) => n.id)).toEqual(['b']);
  });

  it('mixed locked + handling: reason=locked (the harder freeze wins)', () => {
    const allNodes = [
      { id: 'a', type: 'text', data: { locked: true } },
      { id: 'h', type: 'image', data: { status: 'handling' } },
    ];
    const out = gateBlockedDeletion([{ id: 'a' }, { id: 'h' }], [], allNodes);
    expect(out.blocked).toBe(true);
    expect(out.reason).toBe('locked');
    expect(out.survivors.nodes).toHaveLength(0);
  });

  it('blocked=false, reason=null when nothing requested is gated', () => {
    const allNodes = [{ id: 'a', type: 'text', data: {} }];
    const out = gateBlockedDeletion([{ id: 'a' }], [], allNodes);
    expect(out.blocked).toBe(false);
    expect(out.reason).toBeNull();
    expect(out.survivors.nodes.map((n) => n.id)).toEqual(['a']);
  });

  it('does NOT block an explicit edge delete touching a handling node (edges are relations)', () => {
    const allNodes = [{ id: 'h', type: 'image', data: { status: 'handling' } }];
    const out = gateBlockedDeletion(
      [],
      [{ id: 'e1', source: 'h', target: 'b' }],
      allNodes,
    );
    expect(out.blocked).toBe(false);
    expect(out.reason).toBeNull();
    expect(out.survivors.edges.map((e) => e.id)).toEqual(['e1']); // deletable
  });

  it('does NOT block an explicit edge delete touching a locked node (lock never gates edges)', () => {
    const allNodes = [{ id: 'a', type: 'text', data: { locked: true } }];
    const out = gateBlockedDeletion(
      [],
      [{ id: 'e', source: 'a', target: 'b' }],
      allNodes,
    );
    expect(out.blocked).toBe(false);
    expect(out.reason).toBeNull();
    expect(out.survivors.edges.map((e) => e.id)).toEqual(['e']); // deletable
  });
});

describe('handlingNodeIds — nodes with a running task', () => {
  // The delete guards feed VIEW data (the ReactFlow render buffer, a NodeView)
  // whose derived field is `status` — NOT the wire `state`. Fixtures MUST use
  // the view shape or they silently test a dead path (adversarial round: a
  // `data:{state:'handling'}` fixture masked the delete gate being inert).
  it('returns only nodes whose derived view data.status is handling', () => {
    const nodes = [
      { id: 'h1', data: { status: 'handling' } },
      { id: 'h2', data: { status: 'handling' } },
      { id: 'i', data: { status: 'idle' } },
      { id: 'e', data: { status: 'error' } },
      { id: 'n', data: {} },
    ];
    expect(handlingNodeIds(nodes)).toEqual(new Set(['h1', 'h2']));
  });

  it('IGNORES the wire `state` field (only the derived view `status` counts)', () => {
    // A node carrying only the wire shape (no `status`) must NOT match — the
    // guard reads the field the render buffer actually carries. Pins the exact
    // regression the adversarial pass caught.
    expect(handlingNodeIds([{ id: 'w', data: { state: 'handling' } }])).toEqual(
      new Set(),
    );
  });

  it('is empty when nothing is handling', () => {
    expect(handlingNodeIds([{ id: 'a', data: {} }])).toEqual(new Set());
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
