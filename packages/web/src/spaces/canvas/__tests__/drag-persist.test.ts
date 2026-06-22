// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import type { Node } from '@xyflow/react';

import { planDragStop, planDragStopAll } from '@web/spaces/canvas/drag-persist';
import { computeGroupRect } from '@web/spaces/canvas/group-geometry';

/**
 * Build a minimal measured flow node for the drag-stop planner.
 * @param id - Node id.
 * @param x - Position x.
 * @param y - Position y.
 * @param type - Node type (default 'text').
 * @param data - Node data bag (e.g. a group's childIds).
 * @returns A flow node with a measured 100x60 footprint.
 */
function node(
  id: string,
  x: number,
  y: number,
  type = 'text',
  data: Record<string, unknown> = {},
): Node {
  return {
    id,
    type,
    position: { x, y },
    data,
    measured: { width: 100, height: 60 },
  } as Node;
}

describe('planDragStop (multi-select drag persistence — #1432)', () => {
  it('persists EVERY dragged node, not just the first (the bug)', () => {
    // ReactFlow hands onNodeDragStop all co-dragged nodes; the old code only
    // persisted the grabbed one, so the rest snapped back. Every node must
    // appear in the plan with its new position.
    const dragged = [node('a', 0, 0), node('b', 100, 0), node('c', 200, 50)];
    const plan = planDragStop(dragged, dragged);
    expect(plan.positions.map((p) => p.id).sort()).toEqual(['a', 'b', 'c']);
    expect(plan.positions).toContainEqual({
      id: 'b',
      position: { x: 100, y: 0 },
    });
    expect(plan.positions).toContainEqual({
      id: 'c',
      position: { x: 200, y: 50 },
    });
  });

  it('a single dragged node still persists (single-drag back-compat)', () => {
    const plan = planDragStop([node('a', 5, 7)], [node('a', 5, 7)]);
    expect(plan.positions).toEqual([{ id: 'a', position: { x: 5, y: 7 } }]);
  });

  it('skips group nodes — a group position is derived, moved via groupDragRef', () => {
    const dragged = [
      node('g', 0, 0, 'group', { childIds: [] }),
      node('a', 10, 10),
    ];
    const plan = planDragStop(dragged, dragged);
    expect(plan.positions.map((p) => p.id)).toEqual(['a']);
  });

  it('resolves per-node group drop independently (drop into a group → add)', () => {
    // group 'g' wraps member 'm' at (0,0); 'a' dropped with its center inside
    // g's padded rect, and not already a member, must yield an `add` op.
    const m = node('m', 0, 0);
    const g = node('g', 0, 0, 'group', { childIds: ['m'] });
    const a = node('a', 10, 10); // center (60,40) inside g's padded rect
    const plan = planDragStop([a], [g, m, a]);
    expect(plan.groupOps).toContainEqual({
      action: 'add',
      groupId: 'g',
      nodeId: 'a',
    });
  });

  it('does NOT add a node dropped onto a LOCKED group (full plan integration)', () => {
    const m = node('m', 0, 0);
    const g = node('g', 0, 0, 'group', { childIds: ['m'], locked: true });
    const a = node('a', 10, 10); // center inside g's padded rect
    const plan = planDragStop([a], [g, m, a]);
    expect(plan.groupOps).toEqual([]); // locked target group refuses the add
    expect(plan.positions).toContainEqual({
      id: 'a',
      position: { x: 10, y: 10 },
    });
  });
});

describe('planDragStopAll (mixed group + loose marquee drag — #6)', () => {
  it('persists loose node positions even when a group is co-dragged (the bug)', () => {
    // Marquee selects a group AND a loose node, user grabs the group. The old
    // onNodeDragStop returned right after moveGroup, so the loose node's new
    // position never reached Yjs and it snapped back on the next mirror. Every
    // loose node must still be in the plan; the group moves via groupMove.
    const g = node('g', 100, 100, 'group', { childIds: ['m'] });
    const m = node('m', 100, 100);
    const loose = node('a', 300, 300);
    const groupDrag = { id: 'g', startX: 50, startY: 50 };
    const plan = planDragStopAll(g, [g, loose], [g, m, loose], groupDrag);
    expect(plan.positions).toContainEqual({
      id: 'a',
      position: { x: 300, y: 300 },
    });
    expect(plan.groupMove).toEqual({ groupId: 'g', delta: { x: 50, y: 50 } });
    expect(plan.positions.map((p) => p.id)).not.toContain('g');
  });

  it('grabbed loose node (no group drag) → groupMove null, all loose persisted', () => {
    const a = node('a', 10, 10);
    const b = node('b', 20, 20);
    const plan = planDragStopAll(a, [a, b], [a, b], null);
    expect(plan.groupMove).toBeNull();
    expect(plan.positions.map((p) => p.id).sort()).toEqual(['a', 'b']);
  });

  it('does NOT dissolve a co-dragged group: members marquee-dragged WITH the group keep membership (#2 regression)', () => {
    // A real ReactFlow marquee over a group ALSO selects the group's members, so
    // onNodeDragStop's co-dragged set includes them. The old code hit-tested each
    // member against a rect built from only the OTHER members (groupBoxesFor
    // excludes the node being evaluated) — spread-apart members read as "outside"
    // → both removed → group dissolved. With the whole group co-dragged, NO
    // membership op may be emitted.
    const g = node('g', 50, 50, 'group', { childIds: ['m1', 'm2'] });
    const m1 = node('m1', 0, 0);
    const m2 = node('m2', 400, 0); // far from m1 → outside m1's padded rect
    const loose = node('a', 800, 800);
    const all = [g, m1, m2, loose];
    const groupDrag = { id: 'g', startX: 0, startY: 0 }; // delta (50,50) → real groupMove
    const plan = planDragStopAll(g, all, all, groupDrag);
    expect(plan.groupOps).toEqual([]); // membership frozen — no remove, no add
    expect(plan.groupMove).toEqual({ groupId: 'g', delta: { x: 50, y: 50 } });
    // members are owned by groupMove, NOT double-persisted as loose positions
    expect(plan.positions.map((p) => p.id)).not.toContain('m1');
    expect(plan.positions.map((p) => p.id)).not.toContain('m2');
    expect(plan.positions.map((p) => p.id)).toContain('a');
  });

  it('co-selected (not grabbed) group: members keep membership but STILL persist position (#2, no snap-back)', () => {
    // Marquee selects a group + members + a loose node, user grabs the loose
    // node → no group-drag is armed (onNodeDragStart only arms for a grabbed
    // group). ReactFlow still moved the members, so their positions MUST persist
    // (else they snap back, #6), but their membership stays frozen (no dissolve).
    const g = node('g', 0, 0, 'group', { childIds: ['m1', 'm2'] });
    const m1 = node('m1', 0, 0);
    const m2 = node('m2', 400, 0);
    const loose = node('a', 800, 800);
    const all = [g, m1, m2, loose];
    const plan = planDragStopAll(loose, all, all, null);
    expect(plan.groupOps).toEqual([]);
    expect(plan.positions.map((p) => p.id).sort()).toEqual(['a', 'm1', 'm2']);
  });

  it('a lone member dragged out (its group NOT co-dragged) still leaves the group (regression guard)', () => {
    // The legit "drag one member out" path: only the member is in the dragged
    // set, the group is not. Membership must NOT be frozen here — the member
    // leaves as before.
    const g = node('g', 0, 0, 'group', { childIds: ['m1', 'm2'] });
    const m1 = node('m1', 0, 0);
    const m2 = node('m2', 5000, 5000); // dragged far out
    const all = [g, m1, m2];
    const plan = planDragStopAll(m2, [m2], all, null);
    expect(plan.groupOps).toContainEqual({
      action: 'remove',
      groupId: 'g',
      nodeId: 'm2',
    });
  });

  it('grabbed group with zero delta → no-op groupMove', () => {
    const g = node('g', 50, 50, 'group', { childIds: [] });
    const plan = planDragStopAll(g, [g], [g], {
      id: 'g',
      startX: 50,
      startY: 50,
    });
    expect(plan.groupMove).toBeNull();
  });

  it('group grabbed but groupDrag ref mismatched → no groupMove, loose still persist', () => {
    const g = node('g', 100, 100, 'group', { childIds: [] });
    const loose = node('a', 5, 5);
    const plan = planDragStopAll(g, [g, loose], [g, loose], null);
    expect(plan.groupMove).toBeNull();
    expect(plan.positions.map((p) => p.id)).toEqual(['a']);
  });
});

describe('planDragStop with a frozen group snapshot (#1478)', () => {
  // The snapshot is the FULL group container at drag-start (all members,
  // including the one being dragged) — the stable box the member is hit-tested
  // against, instead of the shrunk "other members only" box that made a small
  // in-group nudge read as "outside" and dissolve a 2-member group.
  const snapshot = computeGroupRect([node('m1', 0, 0), node('m2', 200, 0)]);
  const frozen = { groupId: 'g', rect: snapshot! };

  it('a member nudged WITHIN the frozen rect keeps membership (no false dissolve)', () => {
    const g = node('g', 0, 0, 'group', { childIds: ['m1', 'm2'] });
    const m1 = node('m1', 20, 0); // center (70,30) still inside the snapshot
    const m2 = node('m2', 200, 0);
    const plan = planDragStop([m1], [g, m1, m2], new Set(), frozen);
    expect(plan.groupOps).toEqual([]);
  });

  it('a member dragged OUTSIDE the frozen rect leaves the group', () => {
    const g = node('g', 0, 0, 'group', { childIds: ['m1', 'm2'] });
    const m1 = node('m1', 1000, 0); // center far outside the snapshot
    const m2 = node('m2', 200, 0);
    const plan = planDragStop([m1], [g, m1, m2], new Set(), frozen);
    expect(plan.groupOps).toContainEqual({
      action: 'remove',
      groupId: 'g',
      nodeId: 'm1',
    });
  });

  it('WITHOUT a frozen snapshot, a small nudge still dissolves (the bug it fixes)', () => {
    // Documents the pre-fix behavior: no snapshot → groupBoxesFor excludes the
    // dragged node → m1 nudged to (20,0) reads as outside m2's lone box → remove.
    const g = node('g', 0, 0, 'group', { childIds: ['m1', 'm2'] });
    const m1 = node('m1', 20, 0);
    const m2 = node('m2', 200, 0);
    const plan = planDragStop([m1], [g, m1, m2], new Set(), null);
    expect(plan.groupOps).toContainEqual({
      action: 'remove',
      groupId: 'g',
      nodeId: 'm1',
    });
  });
});
