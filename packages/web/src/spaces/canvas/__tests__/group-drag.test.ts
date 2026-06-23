// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import { planGroupDrag, type DragNode } from '@web/spaces/canvas/group-drag';

/**
 * Build a DragNode with an absolute position + size.
 * @param id - Node id.
 * @param type - Node type ('group' for a Group).
 * @param x - Absolute x.
 * @param y - Absolute y.
 * @param w - Width.
 * @param h - Height.
 * @param parentId - Current parent Group id, if any.
 * @returns A DragNode.
 */
function dn(
  id: string,
  type: string,
  x: number,
  y: number,
  w: number,
  h: number,
  parentId?: string,
): DragNode {
  return { id, type, parentId, absPos: { x, y }, size: { width: w, height: h } };
}

describe('planGroupDrag', () => {
  it('A: a top-level node dropped with its center inside a Group joins it (relative position)', () => {
    const f = dn('f', 'group', 0, 0, 200, 200);
    const n = dn('n', 'image', 50, 50, 40, 40); // center (70,70) inside f
    const ops = planGroupDrag([n], [f, n]);
    expect(ops.reparents).toEqual([{ id: 'n', parentId: 'f', position: { x: 50, y: 50 } }]);
    expect(ops.positions).toEqual([]);
    expect(ops.expansions).toEqual([]); // n fits, no growth
  });

  it('B: a member dragged out (center leaves) becomes top-level; the Group does NOT shrink', () => {
    const f = dn('f', 'group', 0, 0, 200, 200);
    const m = dn('m', 'image', 250, 50, 40, 40, 'f'); // center (270,70) outside
    const ops = planGroupDrag([m], [f, m]);
    expect(ops.reparents).toEqual([{ id: 'm', parentId: null, position: { x: 250, y: 50 } }]);
    expect(ops.expansions).toEqual([]); // only-expand: empty group keeps its size
  });

  it('C: a member nudged within (center in, body overflows) keeps the Group, which auto-expands + 24px padding', () => {
    const f = dn('f', 'group', 0, 0, 200, 200);
    const m = dn('m', 'image', 150, 150, 100, 100, 'f'); // center (200,200) edge → in, body to 250
    const ops = planGroupDrag([m], [f, m]);
    expect(ops.reparents).toEqual([]); // membership unchanged
    expect(ops.positions).toEqual([{ id: 'm', position: { x: 150, y: 150 } }]); // relative
    // body reaches 250 → Group grows to 250 + 24 padding = 274 so the member keeps 24px.
    expect(ops.expansions).toEqual([
      { groupId: 'f', position: { x: 0, y: 0 }, width: 274, height: 274 },
    ]);
  });

  it('C-left: drift toward the left/top edge expands the Group top-left with 24px padding', () => {
    const f = dn('f', 'group', 0, 0, 200, 200);
    const m = dn('m', 'image', -10, 90, 40, 40, 'f'); // center (10,110) in; left edge -10
    const ops = planGroupDrag([m], [f, m]);
    // left edge -10 → Group left grows to -10 - 24 = -34 (member keeps 24px on the left).
    expect(ops.expansions).toEqual([
      { groupId: 'f', position: { x: -34, y: 0 }, width: 234, height: 200 },
    ]);
  });

  it('D: dragging a Group persists its absolute position; members are not rewritten (native carry)', () => {
    const f = dn('f', 'group', 300, 300, 200, 200);
    const m = dn('m', 'image', 350, 350, 40, 40, 'f'); // moved natively with the group
    const ops = planGroupDrag([f], [f, m]);
    expect(ops.positions).toEqual([{ id: 'f', position: { x: 300, y: 300 } }]);
    expect(ops.reparents).toEqual([]);
    expect(ops.expansions).toEqual([]); // member already inside
  });

  it('Bug 5: a node dropped inside a LOCKED Group does NOT join it (stays top-level)', () => {
    const locked: DragNode = { ...dn('f', 'group', 0, 0, 200, 200), locked: true };
    const n = dn('n', 'image', 50, 50, 40, 40); // center (70,70) inside the locked group
    const ops = planGroupDrag([n], [locked, n]);
    expect(ops.reparents).toEqual([]); // no membership change into a locked group
    // unchanged top-level node persists at its absolute position
    expect(ops.positions).toEqual([{ id: 'n', position: { x: 50, y: 50 } }]);
    expect(ops.expansions).toEqual([]); // the locked group never grows for it
  });

  it('invariant: after the ops every in-Group member fits the (possibly expanded) Group rect', () => {
    // member stays in (center in) but overflows → group must grow to contain it.
    const f = dn('f', 'group', 0, 0, 200, 200);
    const m = dn('m', 'image', 150, 150, 90, 90, 'f'); // center (195,195) in, body to 240
    const ops = planGroupDrag([m], [f, m]);
    const exp = ops.expansions.find((e) => e.groupId === 'f');
    expect(exp).toBeDefined();
    // the member's right/bottom (240,240) is within the expanded group
    expect(exp!.position.x + exp!.width).toBeGreaterThanOrEqual(240);
    expect(exp!.position.y + exp!.height).toBeGreaterThanOrEqual(240);
  });
});
