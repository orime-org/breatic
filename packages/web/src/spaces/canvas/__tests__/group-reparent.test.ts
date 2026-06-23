// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import {
  planGroupDragStop,
  planResizeJoin,
} from '@web/spaces/canvas/group-reparent';

const GROUP = { id: 'f', rect: { x: 0, y: 0, width: 200, height: 200 } };

describe('planGroupDragStop', () => {
  it('top-level node whose center lands inside a Group joins it', () => {
    const out = planGroupDragStop(
      [{ id: 'n', rect: { x: 50, y: 50, width: 40, height: 40 } }],
      [GROUP],
    );
    expect(out).toEqual([{ nodeId: 'n', targetGroupId: 'f', changed: true }]);
  });

  it('member whose center leaves the Group becomes top-level', () => {
    const out = planGroupDragStop(
      [{ id: 'n', parentId: 'f', rect: { x: 300, y: 50, width: 40, height: 40 } }],
      [GROUP],
    );
    expect(out).toEqual([{ nodeId: 'n', targetGroupId: null, changed: true }]);
  });

  it('member whose center stays inside keeps its Group (no change), body overflow allowed', () => {
    // rect 100x100 at (150,150): body reaches 250 (outside), center (200,200) on
    // the edge → still inside → stays in the Group, unchanged.
    const out = planGroupDragStop(
      [{ id: 'n', parentId: 'f', rect: { x: 150, y: 150, width: 100, height: 100 } }],
      [GROUP],
    );
    expect(out).toEqual([{ nodeId: 'n', targetGroupId: 'f', changed: false }]);
  });

  it('top-level node staying outside every Group is unchanged', () => {
    const out = planGroupDragStop(
      [{ id: 'n', rect: { x: 500, y: 500, width: 40, height: 40 } }],
      [GROUP],
    );
    expect(out).toEqual([{ nodeId: 'n', targetGroupId: null, changed: false }]);
  });

  it('a node never reparents into itself (a Group dragged over another is excluded by the caller)', () => {
    // Defensive: a group in the dragged set must not match itself as a target.
    const out = planGroupDragStop(
      [{ id: 'f', rect: { x: 10, y: 10, width: 40, height: 40 } }],
      [GROUP],
    );
    expect(out).toEqual([{ nodeId: 'f', targetGroupId: null, changed: false }]);
  });

  it('a LOCKED Group never accepts a dragged-in node (its structure is frozen)', () => {
    // Bug 5: a node whose center lands inside a locked Group must NOT join it —
    // a locked Group's membership is frozen (lock = members frozen, content
    // immutable). The node stays top-level (target null, unchanged).
    const out = planGroupDragStop(
      [{ id: 'n', rect: { x: 50, y: 50, width: 40, height: 40 } }],
      [{ ...GROUP, locked: true }],
    );
    expect(out).toEqual([{ nodeId: 'n', targetGroupId: null, changed: false }]);
  });

  it('a node lands in an UNLOCKED Group even when a locked Group also overlaps', () => {
    // The locked Group is skipped as a candidate; an unlocked Group containing
    // the center still accepts the node.
    const out = planGroupDragStop(
      [{ id: 'n', rect: { x: 60, y: 60, width: 20, height: 20 } }],
      [
        { id: 'locked', rect: { x: 0, y: 0, width: 200, height: 200 }, locked: true },
        { id: 'open', rect: { x: 40, y: 40, width: 120, height: 120 } },
      ],
    );
    expect(out).toEqual([{ nodeId: 'n', targetGroupId: 'open', changed: true }]);
  });
});

describe('planResizeJoin — a Group resize absorbs loose nodes whose center it now covers', () => {
  const groupRect = { x: 0, y: 0, width: 200, height: 200 };

  it('a loose node whose center lands inside joins the Group at a parent-relative position', () => {
    const out = planResizeJoin('f', groupRect, [
      { id: 'loose', rect: { x: 50, y: 60, width: 40, height: 40 } },
    ]);
    // center (70,80) is inside → joins; relative position = abs − group top-left.
    expect(out).toEqual([{ id: 'loose', parentId: 'f', position: { x: 50, y: 60 } }]);
  });

  it('a loose node whose center is outside is not absorbed', () => {
    const out = planResizeJoin('f', groupRect, [
      { id: 'far', rect: { x: 300, y: 300, width: 40, height: 40 } },
    ]);
    expect(out).toEqual([]);
  });

  it('relative position subtracts a non-zero Group top-left', () => {
    const out = planResizeJoin(
      'f',
      { x: 100, y: 100, width: 200, height: 200 },
      [{ id: 'n', rect: { x: 150, y: 170, width: 20, height: 20 } }],
    );
    expect(out).toEqual([{ id: 'n', parentId: 'f', position: { x: 50, y: 70 } }]);
  });
});
