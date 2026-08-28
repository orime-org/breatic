// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What this client's own gesture has hold of, and the geometry it publishes
 * for it (#2010, design §5.2 and §5.7 end).
 *
 * One set, two readers: the publisher writes exactly these nodes into
 * awareness, and the merge stage keeps exactly these nodes off the document.
 */

import { describe, expect, it } from 'vitest';

import type { GeometryNode } from '@web/spaces/canvas/local-gesture';
import { gestureGeometry, gestureNodeIds } from '@web/spaces/canvas/local-gesture';

/**
 * Build a top-level node.
 * @param id - Its id.
 * @param x - Its absolute x.
 * @param y - Its absolute y.
 * @returns The node.
 */
function loose(id: string, x: number, y: number): GeometryNode {
  return { id, position: { x, y } };
}

/**
 * Build a Group with a stored size.
 * @param id - Its id.
 * @param x - Its absolute x.
 * @param y - Its absolute y.
 * @param width - Its width.
 * @param height - Its height.
 * @returns The Group node.
 */
function group(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
): GeometryNode {
  return { id, position: { x, y }, width, height };
}

/**
 * Build a Group member, whose position is relative to its Group.
 * @param id - Its id.
 * @param parentId - The Group it belongs to.
 * @param x - Its x relative to the Group.
 * @param y - Its y relative to the Group.
 * @returns The member node.
 */
function member(
  id: string,
  parentId: string,
  x: number,
  y: number,
): GeometryNode {
  return { id, parentId, position: { x, y } };
}

describe('gestureNodeIds', () => {
  it('holds just the node being dragged', () => {
    const ids = gestureNodeIds(['n1'], [loose('n1', 0, 0), loose('n2', 5, 5)]);
    expect([...ids]).toEqual(['n1']);
  });

  it('holds every node of a marquee drag', () => {
    const ids = gestureNodeIds(
      ['n1', 'n2'],
      [loose('n1', 0, 0), loose('n2', 5, 5), loose('n3', 9, 9)],
    );
    expect([...ids].sort()).toEqual(['n1', 'n2']);
  });

  it('pulls a dragged Group members in with it', () => {
    const ids = gestureNodeIds(
      ['g1'],
      [group('g1', 0, 0, 400, 300), member('m1', 'g1', 10, 10), member('m2', 'g1', 20, 20)],
    );
    expect([...ids].sort()).toEqual(['g1', 'm1', 'm2']);
  });

  it('pulls a resized Group members in with it', () => {
    const ids = gestureNodeIds(
      ['g1'],
      [group('g1', 0, 0, 400, 300), member('m1', 'g1', 10, 10)],
    );
    expect([...ids].sort()).toEqual(['g1', 'm1']);
  });

  it('leaves another Group members out', () => {
    const ids = gestureNodeIds(
      ['g1'],
      [
        group('g1', 0, 0, 400, 300),
        member('m1', 'g1', 10, 10),
        group('g2', 500, 0, 400, 300),
        member('m2', 'g2', 10, 10),
      ],
    );
    expect([...ids].sort()).toEqual(['g1', 'm1']);
  });

  it('takes a Group and a loose node dragged together', () => {
    const ids = gestureNodeIds(
      ['g1', 'n1'],
      [group('g1', 0, 0, 400, 300), member('m1', 'g1', 10, 10), loose('n1', 900, 0)],
    );
    expect([...ids].sort()).toEqual(['g1', 'm1', 'n1']);
  });

  it('holds nothing when the gesture has hold of nothing', () => {
    expect(gestureNodeIds([], [loose('n1', 0, 0)]).size).toBe(0);
  });

  it('keeps a seed the buffer no longer carries', () => {
    expect([...gestureNodeIds(['gone'], [loose('n1', 0, 0)])]).toEqual(['gone']);
  });
});

describe('gestureGeometry', () => {
  it('publishes a top-level node position as it stands', () => {
    const published = gestureGeometry(
      new Set(['n1']),
      [loose('n1', 120, 240)],
      null,
    );
    expect(published).toEqual({ n1: { x: 120, y: 240, root: 'n1' } });
  });

  it('turns a member relative position into an absolute one', () => {
    const published = gestureGeometry(
      new Set(['m1']),
      [group('g1', 100, 200, 400, 300), member('m1', 'g1', 10, 20)],
      null,
    );
    // The Group is not in this gesture, so the member speaks for itself.
    expect(published).toEqual({ m1: { x: 110, y: 220, root: 'm1' } });
  });

  it('carries the size of the Group being resized', () => {
    const published = gestureGeometry(
      new Set(['g1']),
      [group('g1', 100, 200, 400, 300)],
      'g1',
    );
    expect(published).toEqual({
      g1: { x: 100, y: 200, width: 400, height: 300, root: 'g1' },
    });
  });

  it('leaves the size off a Group that is only being dragged', () => {
    const published = gestureGeometry(
      new Set(['g1']),
      [group('g1', 100, 200, 400, 300)],
      null,
    );
    expect(published).toEqual({ g1: { x: 100, y: 200, root: 'g1' } });
  });

  it('leaves the size off the members of a resized Group', () => {
    const published = gestureGeometry(
      new Set(['g1', 'm1']),
      [group('g1', 100, 200, 400, 300), member('m1', 'g1', 10, 20)],
      'g1',
    );
    expect(published).toEqual({
      g1: { x: 100, y: 200, width: 400, height: 300, root: 'g1' },
      // The member rode in on the Group, so that is what its entry speaks for.
      m1: { x: 110, y: 220, root: 'g1' },
    });
  });

  it('leaves out a member whose Group is not in the buffer', () => {
    const published = gestureGeometry(
      new Set(['m1']),
      [member('m1', 'missing', 10, 20)],
      null,
    );
    expect(published).toEqual({});
  });

  it('leaves out an id the buffer no longer carries', () => {
    expect(gestureGeometry(new Set(['gone']), [loose('n1', 0, 0)], null)).toEqual({});
  });

  it('publishes nothing for an empty gesture', () => {
    expect(gestureGeometry(new Set(), [loose('n1', 0, 0)], null)).toEqual({});
  });
});
