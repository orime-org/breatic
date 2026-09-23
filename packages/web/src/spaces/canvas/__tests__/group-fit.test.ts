// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import type { Node } from '@xyflow/react';

import { planMeasuredGroupFit } from '@web/spaces/canvas/group-fit';
import {
  EMPTY_NODE_SIZE,
  GROUP_PADDING,
} from '@web/spaces/canvas/group-geometry';

/** The Group a two-file batch arrives in: two empty nodes, padded. */
const GROUP_W = EMPTY_NODE_SIZE.width * 2 + 24 + GROUP_PADDING * 2;
const GROUP_H = EMPTY_NODE_SIZE.height + GROUP_PADDING * 2;

/**
 * A Group and its two members as the document has them.
 * @param locked - Whether the Group carries a lock.
 * @returns The document nodes.
 */
function placesWithGroup(locked = false): Node[] {
  return [
    {
      id: 'g',
      type: 'group',
      position: { x: 100, y: 100 },
      width: GROUP_W,
      height: GROUP_H,
      data: locked ? { locked: true } : {},
    },
    {
      id: 'a',
      type: 'image',
      parentId: 'g',
      position: { x: GROUP_PADDING, y: GROUP_PADDING },
      data: {},
    },
    {
      id: 'b',
      type: 'image',
      parentId: 'g',
      position: {
        x: GROUP_PADDING + EMPTY_NODE_SIZE.width + 24,
        y: GROUP_PADDING,
      },
      data: {},
    },
  ];
}

/**
 * The render buffer, where one member turned out taller than a placeholder.
 * @param tallId - Which member the media made tall.
 * @param height - The height it was measured at.
 * @returns The rendered nodes.
 */
function renderedWithTall(tallId: string, height: number): Node[] {
  return ['a', 'b'].map((id) => ({
    id,
    type: 'image',
    position: { x: 0, y: 0 },
    data: {},
    measured: {
      width: EMPTY_NODE_SIZE.width,
      height: id === tallId ? height : EMPTY_NODE_SIZE.height,
    },
  }));
}

describe('planMeasuredGroupFit', () => {
  it('grows the Group to the height its member turned out to be', () => {
    const tall = EMPTY_NODE_SIZE.height + 300;

    const [fit] = planMeasuredGroupFit(
      placesWithGroup(),
      renderedWithTall('a', tall),
      new Set(),
    );

    expect(fit.groupId).toBe('g');
    expect(fit.height).toBe(tall + GROUP_PADDING * 2);
    // Members keep the top-left they were placed at, so only the bottom-right
    // moves and every stored member position stays true.
    expect(fit.position).toEqual({ x: 100, y: 100 });
    expect(fit.width).toBe(GROUP_W);
  });

  it('leaves a locked Group exactly as it is', () => {
    // The frame is one of the things a Group's lock froze, so a member's media
    // arriving does not get to redraw it.
    expect(
      planMeasuredGroupFit(
        placesWithGroup(true),
        renderedWithTall('a', EMPTY_NODE_SIZE.height + 300),
        new Set(),
      ),
    ).toEqual([]);
  });

  it('writes nothing about a Group a remote gesture is holding', () => {
    expect(
      planMeasuredGroupFit(
        placesWithGroup(),
        renderedWithTall('a', EMPTY_NODE_SIZE.height + 300),
        new Set(['g']),
      ),
    ).toEqual([]);
  });

  it('plans nothing while every member still fits', () => {
    expect(
      planMeasuredGroupFit(
        placesWithGroup(),
        renderedWithTall('a', EMPTY_NODE_SIZE.height),
        new Set(),
      ),
    ).toEqual([]);
  });

  it('leaves a growth that would move the origin to the drag-stop', () => {
    // A member sitting above the frame is not a member that grew; where it
    // belongs is settled when the gesture that put it there ends.
    const places = placesWithGroup();
    places[1] = { ...places[1], position: { x: GROUP_PADDING, y: -40 } };

    expect(
      planMeasuredGroupFit(
        places,
        renderedWithTall('a', EMPTY_NODE_SIZE.height),
        new Set(),
      ),
    ).toEqual([]);
  });

  it('falls back to the empty footprint for a member nothing measured', () => {
    // Culling leaves an off-screen node unmeasured, and every path that has to
    // guess reads the same constant.
    const [fit] = planMeasuredGroupFit(
      [
        ...placesWithGroup().slice(0, 2),
        {
          id: 'b',
          type: 'image',
          parentId: 'g',
          position: { x: GROUP_PADDING, y: GROUP_H },
          data: {},
        },
      ],
      [],
      new Set(),
    );

    expect(fit.height).toBe(GROUP_H + EMPTY_NODE_SIZE.height + GROUP_PADDING);
  });
});
