// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What each planner computes from a buffer carrying a collaborator's in-flight
 * coordinates (#2010, invariant 7).
 *
 * `doc-geometry-view.test.ts` checks the door itself. These cases feed the
 * planners on the other side of it — the ones whose output goes straight into a
 * document write — both views of the same buffer, and pin what each of them
 * says about a node somebody else is moving.
 *
 * Which view the drag-stop passes to which planner argument is `planDragStop`'s
 * to decide and `drag-node.test.ts`'s to pin; nothing here can see that choice.
 */

import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';

import {
  docGeometryView,
  landingCandidates,
} from '@web/spaces/canvas/doc-geometry-view';
import type { GestureTable } from '@web/spaces/canvas/gesture-table';
import { planGroupCreation } from '@web/spaces/canvas/group-creation';
import type { DragNode } from '@web/spaces/canvas/group-drag';
import { toPlacedDragNode } from '@web/spaces/canvas/drag-node';
import { planGroupDrag } from '@web/spaces/canvas/group-drag';
import { planResizeJoin } from '@web/spaces/canvas/group-reparent';
import { captureClipboard } from '@web/spaces/canvas/node-clipboard';

const GROUP_ID = 'g1';
const MEMBER_ID = 'm1';
const FLYING_ID = 'flying';

/** Where the document has the node a remote is dragging. */
const DOC_AT = { x: 40, y: 40 };
/** Where that remote's gesture is currently showing it — far outside the Group. */
const FLYING_AT = { x: 4_000, y: 4_000 };

/**
 * Build a render-buffer node.
 * @param id - Its id.
 * @param x - Its x.
 * @param y - Its y.
 * @param extra - Anything else to put on it.
 * @returns The node.
 */
function node(id: string, x: number, y: number, extra: Partial<Node> = {}): Node {
  return {
    id,
    type: 'image',
    position: { x, y },
    data: {},
    measured: { width: 100, height: 100 },
    ...extra,
  };
}

/**
 * The buffer as it stands mid-remote-gesture: a Group, a member of it, and a
 * loose node the remote has dragged far away.
 * @returns The buffer.
 */
function bufferMidGesture(): Node[] {
  return [
    node(GROUP_ID, 0, 0, { type: 'group', width: 400, height: 300 }),
    node(MEMBER_ID, 20, 20, { parentId: GROUP_ID }),
    node(FLYING_ID, FLYING_AT.x, FLYING_AT.y),
  ];
}

/** The same nodes as the document has them: the flying one has not moved. */
function documentNodes(): Node[] {
  return [
    node(GROUP_ID, 0, 0, { type: 'group', width: 400, height: 300 }),
    node(MEMBER_ID, 20, 20, { parentId: GROUP_ID }),
    node(FLYING_ID, DOC_AT.x, DOC_AT.y),
  ];
}

/** The remote is moving the loose node. */
const REMOTE: GestureTable = new Map([
  [FLYING_ID, { ...FLYING_AT, root: FLYING_ID }],
]);

/** The remote is dragging the Group, which carries its member along. */
const HELD_BY_REMOTE: GestureTable = new Map([
  [GROUP_ID, { x: 0, y: 0, root: GROUP_ID }],
  // The member rode in on the Group, which is what its entry speaks for.
  [MEMBER_ID, { x: 20, y: 20, root: GROUP_ID }],
]);

/**
 * Turn a buffer into the absolute form the drag planner hit-tests with.
 *
 * The real conversion, not a copy of it: a second one here would answer these
 * cases off its own arithmetic and its own fallback size, and would keep
 * answering them after the real one changed.
 * @param all - The whole buffer, for resolving a member's parent.
 * @returns Each node in the planner's absolute form.
 */
function toDragNodes(all: ReadonlyArray<Node>): DragNode[] {
  const byId = new Map(all.map((n) => [n.id, n]));
  return all.map((item) => toPlacedDragNode(item, byId));
}

describe('every write path reads the buffer through the door', () => {
  it('a member keeps its Group while a remote drags that Group', () => {
    // The drag planner reads the buffer to find which Group a dragged node is
    // currently in. A Group missing from that array reads as "this node left
    // its Group", and the stop writes it out to the top level.
    const buffer = bufferMidGesture();
    const dragged = toDragNodes(buffer).filter((n) => n.id === MEMBER_ID);
    const ops = planGroupDrag(
      dragged,
      toDragNodes(buffer),
      new Set(HELD_BY_REMOTE.keys()),
    );
    expect(ops.reparents).toEqual([]);
  });

  it('a Group a remote is holding is not grown by this end', () => {
    // Growing it would write geometry the document has never held.
    const buffer = bufferMidGesture();
    const dragged = toDragNodes(buffer).filter((n) => n.id === MEMBER_ID);
    const ops = planGroupDrag(
      dragged,
      toDragNodes(buffer),
      new Set(HELD_BY_REMOTE.keys()),
    );
    expect(ops.expansions.map((e) => e.groupId)).not.toContain(GROUP_ID);
  });

  it('a resize join takes in only what the document says is inside the new rect', () => {
    const loose = landingCandidates(bufferMidGesture(), REMOTE)
      .filter((n) => n.parentId === undefined && n.type !== 'group')
      .map((n) => ({
        id: n.id,
        rect: {
          x: n.position.x,
          y: n.position.y,
          width: n.measured?.width ?? 288,
          height: n.measured?.height ?? 192,
        },
      }));
    // A node somebody else is dragging is not absorbed: its coordinates are
    // about to change and the document has never held them.
    const joins = planResizeJoin(
      GROUP_ID,
      { x: 0, y: 0, width: 4_400, height: 4_400 },
      loose,
    );
    expect(joins.map((j) => j.id)).not.toContain(FLYING_ID);
  });

  it('a new Group leaves out a member a remote gesture is holding', () => {
    const anchored = node('anchored', 0, 0);
    const another = node('another', 120, 0);
    const buffer = [...bufferMidGesture(), anchored, another];
    // Production hands the planner the ids that survive the filter, which is
    // what this mirrors.
    const picked = [FLYING_ID, 'anchored', 'another'].filter(
      (id) => !REMOTE.has(id),
    );
    const plan = planGroupCreation(buffer, picked, 'new-group');
    expect(plan).not.toBeNull();
    expect(plan?.members.map((m) => m.id).sort()).toEqual(['anchored', 'another']);
    // The box wraps those two, nowhere near the flying node at 4000,4000.
    expect(plan?.width).toBeLessThan(1_000);
  });

  it('the clipboard records the document position, not the one in flight', () => {
    const view = docGeometryView(bufferMidGesture(), documentNodes(), REMOTE);
    const captured = captureClipboard([FLYING_ID], view, new Map());
    expect(captured[0]?.position).toEqual(DOC_AT);
  });

  it('a duplicate places its clone at the document position', () => {
    // `planDuplicateGroupGrowth` reads the same array the clipboard capture
    // does, so the capture standing in for it is the same read.
    const view = docGeometryView(bufferMidGesture(), documentNodes(), REMOTE);
    const captured = captureClipboard([GROUP_ID, FLYING_ID], view, new Map());
    const flying = captured.find((n) => n.position.x === DOC_AT.x);
    expect(flying).toBeDefined();
  });
});
