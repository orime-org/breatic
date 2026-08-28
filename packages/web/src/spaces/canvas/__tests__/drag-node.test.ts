// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The two frames a drag-stop reads geometry in (#2010).
 *
 * These are separate functions because two attempts at one function both ended
 * up answering off the screen whichever list they were handed. Each case here
 * hands BOTH functions the same node and checks they disagree exactly where the
 * two frames disagree — and the last block checks the wiring that picks which
 * function feeds which planner argument, which is the part that was wrong three
 * times while every test stayed green.
 */

import type { Node } from '@xyflow/react';
import { describe, expect, it } from 'vitest';

import {
  planDragStop,
  toPlacedDragNode,
  toScreenDragNode,
} from '@web/spaces/canvas/drag-node';
import { EMPTY_NODE_SIZE } from '@web/spaces/canvas/group-geometry';

/** A Group as the document has it. */
const DOC_GROUP: Node = {
  id: 'g',
  type: 'group',
  position: { x: 100, y: 100 },
  width: 400,
  height: 300,
  data: {},
};

/** The same Group as this screen draws it: a remote has taken it 300 right. */
const SCREEN_GROUP: Node = { ...DOC_GROUP, position: { x: 400, y: 100 } };

/** A member, stored at (50,50) inside the Group either way. */
const MEMBER: Node = {
  id: 'm',
  type: 'image',
  parentId: 'g',
  position: { x: 50, y: 50 },
  measured: { width: 40, height: 40 },
  data: {},
};

const DOC = new Map<string, Node>([
  ['g', DOC_GROUP],
  ['m', MEMBER],
]);
const SCREEN = new Map<string, Node>([
  ['g', SCREEN_GROUP],
  ['m', MEMBER],
]);

describe('toPlacedDragNode', () => {
  it('places a member against the origin of the list it was handed', () => {
    expect(toPlacedDragNode(MEMBER, DOC).absPos).toEqual({ x: 150, y: 150 });
    expect(toPlacedDragNode(MEMBER, SCREEN).absPos).toEqual({ x: 450, y: 150 });
  });

  it('takes a top-level node position as it stands', () => {
    expect(toPlacedDragNode(DOC_GROUP, DOC).absPos).toEqual({ x: 100, y: 100 });
  });

  it('carries the measured size, falling back when nothing measured it', () => {
    expect(toPlacedDragNode(MEMBER, DOC).size).toEqual({ width: 40, height: 40 });
    expect(toPlacedDragNode(DOC_GROUP, DOC).size).toEqual({
      width: 400,
      height: 300,
    });
  });

  it('sizes an unmeasured node the same as every other geometry path does', () => {
    // The size decides where the centre is and the centre decides which Group
    // a node belongs to, so a number of this module's own would answer that
    // question differently from the paths running in the same frame. It did:
    // extracting this module wrote 200 where the canvas reads 192.
    const unmeasured: Node = { id: 'u', type: 'image', position: { x: 0, y: 0 }, data: {} };
    expect(toPlacedDragNode(unmeasured, new Map()).size).toEqual({
      width: EMPTY_NODE_SIZE.width,
      height: EMPTY_NODE_SIZE.height,
    });
  });

  it('leaves a member whose Group is missing at its stored position', () => {
    expect(toPlacedDragNode(MEMBER, new Map()).absPos).toEqual({ x: 50, y: 50 });
  });
});

describe('toScreenDragNode', () => {
  it('takes the painted point over anything the list would work out', () => {
    // ReactFlow moves the node it is dragging every pointer event, while the
    // buffer this list came from is a frame behind. The painted point is the
    // one the pointer was over, so a value that disagrees with the list has to
    // win -- checked with a point no arithmetic over SCREEN can produce.
    expect(toScreenDragNode(MEMBER, SCREEN, { x: 777, y: 888 }).absPos).toEqual({
      x: 777,
      y: 888,
    });
  });

  it('falls back to the list for a node ReactFlow has not taken in yet', () => {
    expect(toScreenDragNode(MEMBER, SCREEN, undefined).absPos).toEqual({
      x: 450,
      y: 150,
    });
  });
});

describe('the two frames', () => {
  it('disagree by exactly the travel a remote has made', () => {
    // This is the property the last two rounds asserted and did not have: the
    // document conversion has to answer the document, whatever ReactFlow is
    // painting. 450 - 150 = 300, the remote's travel.
    const painted = toScreenDragNode(MEMBER, SCREEN, { x: 450, y: 150 });
    const stored = toPlacedDragNode(MEMBER, DOC);
    expect(painted.absPos.x - stored.absPos.x).toBe(300);
  });
});

describe('planDragStop', () => {
  // A remote is resizing Group g by its LEFT edge: the document still has the
  // Group at x=100, this screen draws it at x=0. A member stores its offset
  // from whichever origin it was measured against, and the remote's own resize
  // will subtract its whole travel from whatever this end writes -- so only the
  // document origin lands right. The two origins are 100 apart, which is what
  // makes every wrong pairing of view and argument produce a different number.
  const RESIZED_DOC_GROUP: Node = {
    id: 'g',
    type: 'group',
    position: { x: 100, y: 0 },
    width: 200,
    height: 200,
    data: {},
  };
  const RESIZED_SCREEN_GROUP: Node = {
    ...RESIZED_DOC_GROUP,
    position: { x: 0, y: 0 },
    width: 300,
  };
  const INSIDE: Node = {
    id: 'm',
    type: 'image',
    parentId: 'g',
    position: { x: 50, y: 50 },
    measured: { width: 100, height: 100 },
    data: {},
  };
  /** Where this user released the member, in absolute screen coordinates. */
  const RELEASED = { x: 60, y: 90 };
  // ReactFlow keeps an absolute position for every node it has been handed,
  // rendered or culled, so it has one for the Group too -- the place the resize
  // is drawing it at. Leaving that out is what let a first version of this test
  // stay green while the wiring was mutated: with no painted point a Group
  // falls back to its own stored position, and both frames then agree.
  const PAINTED = new Map([
    ['g', RESIZED_SCREEN_GROUP.position],
    ['m', RELEASED],
  ]);

  /**
   * Run a drag-stop of the member while the remote resize is running.
   * @returns The ops the planner produced.
   */
  const run = (): ReturnType<typeof planDragStop> =>
    planDragStop({
      dragged: [INSIDE],
      onScreen: [RESIZED_SCREEN_GROUP, INSIDE],
      settled: [RESIZED_DOC_GROUP, INSIDE],
      heldByRemote: new Set(['g']),
      resizedByRemote: new Set(['g']),
      paintedAt: (id) => PAINTED.get(id),
    });

  it('writes the member against the origin the document has, not the drawn one', () => {
    // 60 - 100. Against the drawn origin it would be 60 - 0 = 60, which is the
    // value the two previous rounds wrote and no test caught.
    expect(run().positions).toEqual([
      { id: 'm', position: { x: -40, y: 90 }, parentId: 'g' },
    ]);
  });

  it('takes the released point for the member, not its place in either list', () => {
    // Both lists put the member somewhere else: 150 in the document, 50 on
    // screen. Handing the dragged node the document view instead of the screen
    // one writes where the drag STARTED.
    const [written] = run().positions;
    expect(written?.position.x).not.toBe(50);
    expect(written?.position.x).not.toBe(150);
  });

  it('leaves the Group a remote is resizing alone', () => {
    expect(run().expansions).toEqual([]);
  });

  it('works a node ReactFlow has no answer for out of the drawn list', () => {
    // A node that reached the buffer from the document after the last render
    // is not in ReactFlow's lookup yet, and the list is what places it. It has
    // to be the drawn list: the Group it hangs off is drawn 500 to the right of
    // where the document has it, and a member measured from the document origin
    // would be written half a screen from its own Group.
    const drawn: Node = {
      id: 'g',
      type: 'group',
      position: { x: 500, y: 0 },
      width: 400,
      height: 400,
      data: {},
    };
    const stored: Node = { ...drawn, position: { x: 0, y: 0 } };
    const member: Node = {
      id: 'm',
      type: 'image',
      parentId: 'g',
      position: { x: 100, y: 100 },
      measured: { width: 100, height: 100 },
      data: {},
    };
    const ops = planDragStop({
      dragged: [member],
      onScreen: [drawn, member],
      settled: [stored, member],
      heldByRemote: new Set(),
      resizedByRemote: new Set(),
      paintedAt: (id) => (id === 'g' ? drawn.position : undefined),
    });
    // 600 against the drawn origin 500. Off the settled list it works out to
    // 100, which is 400 to the left of the Group and outside it altogether.
    expect(ops.positions).toEqual([
      { id: 'm', position: { x: 100, y: 100 }, parentId: 'g' },
    ]);
    expect(ops.reparents).toEqual([]);
  });

  it('judges the landing against the box on screen, which is the one aimed at', () => {
    // The buffer list decides which Group a release lands in, and a resize is
    // the case where the two lists disagree about a Group's extent: the remote
    // has pulled the right edge out to 400, the document still says 200. The
    // user aimed at the box they can see, so a release at 250 is inside it --
    // judged against the document's box the same release falls outside and the
    // member is evicted to the top level.
    const drawn: Node = {
      id: 'g',
      type: 'group',
      position: { x: 0, y: 0 },
      width: 400,
      height: 400,
      data: {},
    };
    const stored: Node = { ...drawn, width: 200, height: 200 };
    const member: Node = {
      id: 'm',
      type: 'image',
      parentId: 'g',
      position: { x: 10, y: 10 },
      measured: { width: 100, height: 100 },
      data: {},
    };
    const ops = planDragStop({
      dragged: [member],
      onScreen: [drawn, member],
      settled: [stored, member],
      heldByRemote: new Set(),
      resizedByRemote: new Set(),
      paintedAt: (id) => (id === 'm' ? { x: 250, y: 250 } : drawn.position),
    });
    expect(ops.reparents).toEqual([]);
    expect(ops.positions).toEqual([
      { id: 'm', position: { x: 250, y: 250 }, parentId: 'g' },
    ]);
  });

  it('grows a Group around where the pointer released a member, not where it was', () => {
    // The third list decides what a Group is sized around. Nobody else is on
    // the canvas here, so the two lists hold the same nodes and the only thing
    // that separates the frames is the painted point -- which is the whole
    // difference between growing around where the user dropped something and
    // growing around where they picked it up.
    const group: Node = {
      id: 'g',
      type: 'group',
      position: { x: 0, y: 0 },
      width: 200,
      height: 200,
      data: {},
    };
    const member: Node = {
      id: 'm',
      type: 'image',
      parentId: 'g',
      position: { x: 10, y: 10 },
      measured: { width: 100, height: 100 },
      data: {},
    };
    const both = [group, member];
    const ops = planDragStop({
      dragged: [member],
      onScreen: both,
      settled: both,
      heldByRemote: new Set(),
      resizedByRemote: new Set(),
      paintedAt: (id) => (id === 'm' ? { x: 150, y: 150 } : group.position),
    });
    // Released at (150,150) and 100 wide, so it runs to (250,250) and the Group
    // has to reach that far. Sized around its stored place it would still fit
    // inside the Group as it stands, and nothing would grow.
    expect(ops.expansions).toEqual([
      { groupId: 'g', position: { x: 0, y: 0 }, width: 274, height: 274 },
    ]);
  });
});
