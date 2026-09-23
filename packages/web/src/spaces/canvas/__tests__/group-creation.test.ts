// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import type { Node } from '@xyflow/react';

import { dropPositionAt } from '@web/spaces/canvas/drop-layout';
import { planGroupCreation } from '@web/spaces/canvas/group-creation';
import {
  EMPTY_NODE_SIZE,
  GROUP_PADDING,
} from '@web/spaces/canvas/group-geometry';
import { centerToTopLeft } from '@web/spaces/canvas/node-factory';

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

  describe('the Group one multi-file upload becomes (#2209)', () => {
    /**
     * The batch as the drop hands it to the planner: one node per file, placed
     * by `dropPositionAt` and written at the top-left `createUploadNodeAt`
     * derives from it. None is measured yet, which is what the canvas passes.
     * @param count - How many files the drop admitted.
     * @returns The flow nodes for that batch, in the order they were placed.
     */
    function batch(count: number): Node[] {
      return Array.from({ length: count }, (_, i) => {
        const centre = dropPositionAt({ x: 0, y: 0 }, i);
        return {
          id: `f${String(i)}`,
          type: 'image',
          position: centerToTopLeft(centre, EMPTY_NODE_SIZE),
          data: {},
        };
      });
    }

    it('frames two files with the padding, and keeps them a gap apart', () => {
      const nodes = batch(2);
      const plan = planGroupCreation(
        nodes,
        nodes.map((n) => n.id),
        'g-2',
      );

      // 288x192 nodes one 312 step apart, padded by 24 on every side.
      expect(plan).not.toBeNull();
      expect(plan?.position).toEqual({ x: -168, y: -120 });
      expect(plan?.width).toBe(648);
      expect(plan?.height).toBe(240);
      expect(plan?.members).toEqual([
        { id: 'f0', position: { x: 24, y: 24 } },
        { id: 'f1', position: { x: 336, y: 24 } },
      ]);
    });

    it('is two rows tall once the fifth file wraps', () => {
      const nodes = batch(5);
      const plan = planGroupCreation(
        nodes,
        nodes.map((n) => n.id),
        'g-5',
      );

      // Four across, so the fifth starts a second row one 216 step down.
      expect(plan?.position).toEqual({ x: -168, y: -120 });
      expect(plan?.width).toBe(1272);
      expect(plan?.height).toBe(456);
      expect(plan?.members.map((m) => m.position)).toEqual([
        { x: 24, y: 24 },
        { x: 336, y: 24 },
        { x: 648, y: 24 },
        { x: 960, y: 24 },
        { x: 24, y: 240 },
      ]);
    });

    it('leaves a single file on its own', () => {
      const nodes = batch(1);

      expect(
        planGroupCreation(
          nodes,
          nodes.map((n) => n.id),
          'g-1',
        ),
      ).toBeNull();
    });
  });
});
