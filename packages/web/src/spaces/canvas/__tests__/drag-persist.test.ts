// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import type { Node } from '@xyflow/react';

import { planDragStop, planDragStopAll } from '@web/spaces/canvas/drag-persist';

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
