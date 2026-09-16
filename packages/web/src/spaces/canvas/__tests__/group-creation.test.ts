// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import type { Node } from '@xyflow/react';

import { planGroupCreation } from '@web/spaces/canvas/group-creation';
import {
  EMPTY_NODE_SIZE,
  GROUP_PADDING,
} from '@web/spaces/canvas/group-geometry';

/**
 * Build a flow node with an explicit measured size for deterministic rects.
 * @param id - Node id.
 * @param x - Absolute x.
 * @param y - Absolute y.
 * @param w - Measured width.
 * @param h - Measured height.
 * @param selected - Selection flag.
 * @returns A ReactFlow node.
 */
function node(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  selected = true,
): Node {
  return {
    id,
    type: 'image',
    position: { x, y },
    data: {},
    measured: { width: w, height: h },
    selected,
  };
}

/**
 * Build a collapsed annotation, the size xyflow measures it at this zoom.
 * @param id - Node id.
 * @param x - Absolute x.
 * @param y - Absolute y.
 * @returns A ReactFlow node of type annotation.
 */
function pin(id: string, x: number, y: number): Node {
  return {
    id,
    type: 'annotation',
    position: { x, y },
    data: {},
    measured: { width: 28, height: 28 },
    selected: true,
  };
}

describe('planGroupCreation', () => {
  it('leaves a note out of the group, and its frame', () => {
    // A note is a remark about the canvas, not a thing on it (user
    // 2026-09-15). It also cannot be framed honestly: a pin holds 28 SCREEN
    // pixels, so its flow-space footprint is 28/zoom — a group sized around it
    // would be a different size depending on who was looking.
    const plan = planGroupCreation(
      [node('a', 0, 0, 100, 100), node('b', 300, 0, 100, 100), pin('note', 150, 500)],
      ['a', 'b', 'note'],
      'g1',
    );
    expect(plan?.members.map((m) => m.id)).toEqual(['a', 'b']);
    expect(plan?.height).toBe(100 + GROUP_PADDING * 2);
  });

  it('makes no group when a note is one of the only two picked', () => {
    expect(
      planGroupCreation([node('a', 0, 0, 100, 100), pin('note', 10, 10)], ['a', 'note'], 'g1'),
    ).toBeNull();
  });

  it('wraps a node nothing has measured at the size a node is created at', () => {
    // Culling leaves a node that has never been on screen without a measured
    // size, and a content node stores none. Every path that has to guess reads
    // one constant, because the guess decides where the node's centre is and
    // the centre decides which Group it belongs to -- this planner answering it
    // its own way puts a member outside the box built around it, for good.
    const unmeasured: Node = {
      id: 'u',
      type: 'image',
      position: { x: 0, y: 0 },
      data: {},
      selected: true,
    };
    const plan = planGroupCreation(
      [unmeasured, node('b', 0, 0, 10, 10)],
      ['u', 'b'],
      'group',
    );
    // The unmeasured node is the far corner on both axes, so both extents are
    // its assumed size plus the Group's padding.
    expect(plan?.width).toBe(EMPTY_NODE_SIZE.width + 2 * GROUP_PADDING);
    expect(plan?.height).toBe(EMPTY_NODE_SIZE.height + 2 * GROUP_PADDING);
  });

  it('returns null for fewer than two selected nodes', () => {
    expect(planGroupCreation([node('a', 0, 0, 50, 50)], ['a'], 'group')).toBeNull();
  });

  it('group rect = members bounding box + padding on every side', () => {
    const nodes = [
      node('a', 100, 100, 50, 50), // 100..150
      node('b', 200, 180, 40, 40), // x 200..240, y 180..220
    ];
    const plan = planGroupCreation(nodes, ['a', 'b'], 'group');
    expect(plan).not.toBeNull();
    expect(plan!.position).toEqual({ x: 100 - GROUP_PADDING, y: 100 - GROUP_PADDING });
    expect(plan!.width).toBe(240 - 100 + 2 * GROUP_PADDING);
    expect(plan!.height).toBe(220 - 100 + 2 * GROUP_PADDING);
    expect(plan!.groupId).toBe('group');
  });

  it('members get positions relative to the group top-left + are listed', () => {
    const nodes = [
      node('a', 100, 100, 50, 50),
      node('b', 200, 180, 40, 40),
    ];
    const plan = planGroupCreation(nodes, ['a', 'b'], 'group')!;
    const top = plan.position; // padded top-left
    const byId = Object.fromEntries(plan.members.map((m) => [m.id, m.position]));
    expect(byId['a']).toEqual({ x: 100 - top.x, y: 100 - top.y });
    expect(byId['b']).toEqual({ x: 200 - top.x, y: 180 - top.y });
  });

});
