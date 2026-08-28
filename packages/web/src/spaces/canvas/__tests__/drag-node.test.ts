// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The two frames a drag-stop reads geometry in (#2010).
 *
 * These are separate functions because two attempts at one function both ended
 * up answering off the screen whichever list they were handed. Each case here
 * hands BOTH functions the same node and checks they disagree exactly where the
 * two frames disagree.
 */

import { describe, expect, it } from 'vitest';

import type { PlaceableNode } from '@web/spaces/canvas/drag-node';
import {
  toPlacedDragNode,
  toScreenDragNode,
} from '@web/spaces/canvas/drag-node';

/** A Group as the document has it. */
const DOC_GROUP: PlaceableNode = {
  id: 'g',
  type: 'group',
  position: { x: 100, y: 100 },
  width: 400,
  height: 300,
};

/** The same Group as this screen draws it: a remote has taken it 300 right. */
const SCREEN_GROUP: PlaceableNode = { ...DOC_GROUP, position: { x: 400, y: 100 } };

/** A member, stored at (50,50) inside the Group either way. */
const MEMBER: PlaceableNode = {
  id: 'm',
  type: 'image',
  parentId: 'g',
  position: { x: 50, y: 50 },
  measured: { width: 40, height: 40 },
};

const DOC = new Map<string, PlaceableNode>([
  ['g', DOC_GROUP],
  ['m', MEMBER],
]);
const SCREEN = new Map<string, PlaceableNode>([
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
    expect(toPlacedDragNode(DOC_GROUP, DOC).size).toEqual({ width: 400, height: 300 });
  });

  it('leaves a member whose Group is missing at its stored position', () => {
    expect(toPlacedDragNode(MEMBER, new Map()).absPos).toEqual({ x: 50, y: 50 });
  });
});

describe('toScreenDragNode', () => {
  it('takes the painted point when ReactFlow has one', () => {
    expect(toScreenDragNode(MEMBER, SCREEN, { x: 450, y: 150 }).absPos).toEqual({
      x: 450,
      y: 150,
    });
  });

  it('falls back to the screen list for a node ReactFlow is not rendering', () => {
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
