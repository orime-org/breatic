// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';

import { batchCentresAt, NODE_STEP } from '@web/spaces/canvas/drop-layout';
import { EMPTY_NODE_SIZE } from '@web/spaces/canvas/group-geometry';

const ORIGIN = { x: 100, y: 200 };

/** How many go across before the layout starts a second row. */
function firstWrap(): number {
  const wide = batchCentresAt(ORIGIN, 64);
  for (let i = 1; i < wide.length; i += 1) {
    if (wide[i].y !== wide[0].y) return i;
  }
  throw new Error('the layout never wraps');
}

/**
 * The middle of the box the batch's node centres span.
 * @param count - How many files the batch admitted.
 * @returns The centre of the batch, in canvas coordinates.
 */
function centreOfBatch(count: number): { x: number; y: number } {
  const at = batchCentresAt(ORIGIN, count);
  const xs = at.map((p) => p.x);
  const ys = at.map((p) => p.y);
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}

describe('batchCentresAt', () => {
  it('puts a single file exactly where the batch came in', () => {
    expect(batchCentresAt(ORIGIN, 1)).toEqual([ORIGIN]);
  });

  it('centres the batch on that point however many files it holds', () => {
    // What the reader pointed at is the middle of what appears, so the batch
    // does not sprawl off to one side the way a top-left anchor would.
    for (const count of [2, 3, 4, 5, 9]) {
      expect(centreOfBatch(count)).toEqual(ORIGIN);
    }
  });

  it('steps neighbours past the column drawn beside a node', () => {
    // The task-count column is drawn outside the node's right edge, so a step
    // of the node's own width alone would put the next node on top of it.
    const [first, second] = batchCentresAt(ORIGIN, 2);
    expect(second.x - first.x).toBeGreaterThan(EMPTY_NODE_SIZE.width);
    expect(second.y).toBe(first.y);
  });

  it('wraps to a new row rather than running off to the right', () => {
    const wrap = firstWrap();
    const at = batchCentresAt(ORIGIN, wrap + 1);
    expect(at[wrap].y - at[0].y).toBeGreaterThanOrEqual(EMPTY_NODE_SIZE.height);
    expect(at[wrap].x).toBe(at[0].x);
  });

  it('lays a batch out so no two nodes share a position', () => {
    const seen = new Set(batchCentresAt(ORIGIN, 20).map((p) => `${p.x},${p.y}`));
    expect(seen.size).toBe(20);
  });

  it('makes nothing for an empty batch', () => {
    expect(batchCentresAt(ORIGIN, 0)).toEqual([]);
  });

  it('steps by the node footprint plus a gap', () => {
    expect(NODE_STEP.x).toBeGreaterThan(EMPTY_NODE_SIZE.width);
    expect(NODE_STEP.y).toBeGreaterThan(EMPTY_NODE_SIZE.height);
  });
});
