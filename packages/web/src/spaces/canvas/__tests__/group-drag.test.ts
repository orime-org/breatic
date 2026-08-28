// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
    expect(ops.positions).toEqual([
      { id: 'm', position: { x: 150, y: 150 }, parentId: 'f' },
    ]); // relative
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
    // The member position is measured against the origin the expansion is
    // moving the Group to, so the whole drag takes one write per node and the
    // member lands at the absolute place the pointer left it (#2010,
    // acceptance 9): -34 + 24 = -10.
    expect(ops.positions).toEqual([
      { id: 'm', position: { x: 24, y: 90 }, parentId: 'f' },
    ]);
  });

  it('C-left: an untouched member of the growing Group stays where it is', () => {
    // The expansion moves the origin every member is measured against, and the
    // Group's own write says nothing about members — so a member the pointer
    // never touched needs its own position stated against the new origin, or
    // this drag moves it (#2010, acceptance 9 plus "a resize moves nothing").
    const f = dn('f', 'group', 0, 0, 200, 200);
    const m = dn('m', 'image', -10, 90, 40, 40, 'f'); // dragged, pushes the left edge out
    const o = dn('o', 'image', 100, 100, 40, 40, 'f'); // untouched
    const ops = planGroupDrag([m], [f, m, o]);
    const origin = ops.expansions[0]?.position;
    expect(origin).toEqual({ x: -34, y: 0 });
    const untouched = ops.positions.find((p) => p.id === 'o');
    expect(untouched).toBeDefined();
    // Absolute position unchanged: -34 + 134 = 100, the same 100 it started at.
    expect((origin?.x ?? 0) + (untouched?.position.x ?? 0)).toBe(100);
    expect((origin?.y ?? 0) + (untouched?.position.y ?? 0)).toBe(100);
  });

  it('takes one position write for a dragged Group that also grows', () => {
    // The expansion writes the Group's position along with its size, so a
    // second position op for the same Group is a second write of one key
    // (#2010, acceptance 9).
    const f = dn('f', 'group', 0, 0, 200, 200);
    const m = dn('m', 'image', 24, 24, 152, 166, 'f'); // bottom 190 > 200 - 24
    const ops = planGroupDrag([f, m], [f, m]);
    expect(ops.expansions.map((e) => e.groupId)).toEqual(['f']);
    expect(ops.positions.map((p) => p.id)).not.toContain('f');
  });

  it('leaves an untouched member alone when the Group does not move', () => {
    // Growing right and down keeps the origin, so nothing about the members
    // needs restating and the drag stays at one write for the node it moved.
    const f = dn('f', 'group', 0, 0, 200, 200);
    const m = dn('m', 'image', 150, 150, 100, 100, 'f'); // body overflows right/bottom
    const o = dn('o', 'image', 50, 50, 40, 40, 'f');
    const ops = planGroupDrag([m], [f, m, o]);
    expect(ops.expansions[0]?.position).toEqual({ x: 0, y: 0 });
    expect(ops.positions.map((p) => p.id)).toEqual(['m']);
  });

  it('D: dragging a Group persists its absolute position; members are not rewritten (native carry)', () => {
    const f = dn('f', 'group', 300, 300, 200, 200);
    const m = dn('m', 'image', 350, 350, 40, 40, 'f'); // moved natively with the group
    const ops = planGroupDrag([f], [f, m]);
    expect(ops.positions).toEqual([
      { id: 'f', position: { x: 300, y: 300 }, parentId: null },
    ]);
    expect(ops.reparents).toEqual([]);
    expect(ops.expansions).toEqual([]); // member already inside
  });

  it('Bug 5: a node dropped inside a LOCKED Group does NOT join it (stays top-level)', () => {
    const locked: DragNode = { ...dn('f', 'group', 0, 0, 200, 200), locked: true };
    const n = dn('n', 'image', 50, 50, 40, 40); // center (70,70) inside the locked group
    const ops = planGroupDrag([n], [locked, n]);
    expect(ops.reparents).toEqual([]); // no membership change into a locked group
    // unchanged top-level node persists at its absolute position
    expect(ops.positions).toEqual([
      { id: 'n', position: { x: 50, y: 50 }, parentId: null },
    ]);
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

describe('planGroupDrag while a remote gesture holds part of the canvas', () => {
  /**
   * A node in the form the planner takes.
   * @param id - Its id.
   * @param type - Its type.
   * @param x - Absolute x.
   * @param y - Absolute y.
   * @param w - Width.
   * @param h - Height.
   * @param parentId - Its Group, if any.
   * @returns The drag node.
   */
  function at(
    id: string,
    type: string,
    x: number,
    y: number,
    w: number,
    h: number,
    parentId?: string,
  ): DragNode {
    return {
      id,
      type,
      parentId,
      absPos: { x, y },
      size: { width: w, height: h },
      locked: false,
    };
  }

  it('leaves a member in its Group while a remote drags that Group', () => {
    // The Group still answers "which Group is this node in" — it is only kept
    // out of the decisions that would write.
    const all = [
      at('g1', 'group', 0, 0, 400, 300),
      at('m1', 'image', 20, 20, 100, 100, 'g1'),
    ];
    const ops = planGroupDrag([all[1]], all, new Set(['g1', 'm1']));
    expect(ops.reparents).toEqual([]);
  });

  it('sizes a Group off its settled members only', () => {
    // m1 is being dragged by somebody else and is currently drawn far outside
    // the Group; growing g1 around it would write a rect the document has
    // never held, and expandGroupToWrap never shrinks back.
    const all = [
      at('g1', 'group', 0, 0, 400, 300),
      at('m1', 'image', 600, 20, 100, 100, 'g1'),
      at('x1', 'image', 900, 900, 100, 100),
    ];
    const ops = planGroupDrag([all[2]], all, new Set(['m1']));
    expect(ops.expansions).toEqual([]);
  });

  it('does not offer a Group a remote is holding as a landing target', () => {
    const all = [
      at('g1', 'group', 0, 0, 400, 300),
      at('loose', 'image', 100, 100, 100, 100),
    ];
    const ops = planGroupDrag([all[1]], all, new Set(['g1']));
    expect(ops.reparents).toEqual([]);
  });
});

describe('planGroupDrag against geometry a remote is still moving', () => {
  it('restates a member a remote is holding when the origin moves', () => {
    // Growing left moves the origin every member is measured from. A member
    // somebody else is dragging has to be restated too, or the Group's write
    // moves it in the document -- and the value restated is the document's,
    // not the place the other end is showing it at.
    const g = dn('g', 'group', 0, 0, 200, 200);
    const dragged = dn('m', 'image', -10, 90, 40, 40, 'g'); // pushes the edge out
    const flyingScreen = dn('r', 'image', 900, 900, 40, 40, 'g');
    const flyingDoc = dn('r', 'image', 100, 100, 40, 40, 'g');
    const ops = planGroupDrag(
      [dragged],
      [g, dragged, flyingScreen],
      new Set(['r']),
      [g, dragged, flyingDoc],
    );
    expect(ops.expansions[0]?.position).toEqual({ x: -34, y: 0 });
    const restated = ops.positions.find((p) => p.id === 'r');
    expect(restated?.position).toEqual({ x: 134, y: 100 }); // 100 - (-34), 100 - 0
  });

  it('measures a member against the document origin while a remote resizes the Group', () => {
    // A resize moves no member, so it subtracts its whole travel from each
    // stored position. That lands right only when the position was measured
    // from the Group's document origin.
    const screenGroup = dn('g', 'group', 300, 0, 200, 200);
    const docGroup = dn('g', 'group', 0, 0, 200, 200);
    const m = dn('m', 'image', 350, 50, 40, 40, 'g');
    const ops = planGroupDrag(
      [m],
      [screenGroup, m],
      new Set(['g']),
      [docGroup, m],
      new Set(['g']),
    );
    const stated = ops.positions.find((p) => p.id === 'm');
    expect(stated?.position).toEqual({ x: 350, y: 50 }); // 350 - 0, not 350 - 300
  });

  it('keeps measuring against the on-screen origin while a remote drags the Group', () => {
    // A drag carries its members along, so a member nudged inside it belongs at
    // that spot in the Group and travels the rest of the way with it.
    const screenGroup = dn('g', 'group', 300, 0, 200, 200);
    const docGroup = dn('g', 'group', 0, 0, 200, 200);
    const m = dn('m', 'image', 350, 50, 40, 40, 'g');
    const ops = planGroupDrag(
      [m],
      [screenGroup, m],
      new Set(['g']),
      [docGroup, m],
    );
    const stated = ops.positions.find((p) => p.id === 'm');
    expect(stated?.position).toEqual({ x: 50, y: 50 }); // 350 - 300
  });

  it('grows the Group around a member this drag dropped, remote hand on it or not', () => {
    // Two people can hold one node. A member only a remote holds is about to
    // land somewhere this end cannot know, so the Group is not sized around it
    // -- but a member of THIS drag is not such a node: the pointer released it
    // here, and the place it is being written to is the place the Group has to
    // reach. Writing the position while refusing to grow leaves the document
    // with a member outside its own Group, and Groups never shrink back.
    const g = dn('g', 'group', 0, 0, 200, 200);
    const dropped = dn('m', 'image', 20, 140, 100, 100, 'g'); // runs to y=240
    const ops = planGroupDrag(
      [dropped],
      [g, dropped],
      new Set(['m']),
      [g, dn('m', 'image', 20, 20, 100, 100, 'g')],
    );
    // The Group reaches past the member by GROUP_PADDING on every side it has
    // to move, so its origin goes to (-4,0) and the member is restated against
    // it. Sized around the settled place instead, nothing grows at all.
    expect(ops.expansions).toEqual([
      { groupId: 'g', position: { x: -4, y: 0 }, width: 204, height: 264 },
    ]);
    expect(ops.positions).toEqual([
      { id: 'm', position: { x: 24, y: 140 }, parentId: 'g' },
    ]);
  });
});
