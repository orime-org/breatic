// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where a proposal lands when the spot it was aimed at is taken (inner#1443).
 *
 * The batch only moves right, and it stops at the first place where it covers
 * nothing already on the canvas, keeping a gap on every side.
 */

import { describe, it, expect } from 'vitest';

import { EMPTY_NODE_SIZE, mediaNodeHeight } from '@web/spaces/canvas/group-geometry';
import { ROW_GAP_PX, shiftRightPastOccupied, textFootprintHeight } from '@web/spaces/canvas/lib/place-flow';

const GAP = ROW_GAP_PX;
const batch = { x: 1000, y: 500, width: 288, height: 192 };

describe('shiftRightPastOccupied', () => {
  it('leaves the batch where it is on an empty canvas', () => {
    expect(shiftRightPastOccupied(batch, [], GAP)).toBe(0);
  });

  it('leaves the batch where it is when nothing is near it', () => {
    const farAway = { x: 0, y: 0, width: 288, height: 192 };
    expect(shiftRightPastOccupied(batch, [farAway], GAP)).toBe(0);
  });

  it('moves past a node on its spot to that node right edge plus the gap', () => {
    const taken = { x: 900, y: 450, width: 288, height: 192 };
    const dx = shiftRightPastOccupied(batch, [taken], GAP);
    expect(batch.x + dx).toBe(taken.x + taken.width + GAP);
  });

  it('keeps going when the next spot is taken too', () => {
    const first = { x: 1000, y: 500, width: 288, height: 192 };
    // Out of reach of the first try (which ends at 1336), in reach of the
    // spot past `first`.
    const second = { x: 1350, y: 600, width: 288, height: 400 };
    const dx = shiftRightPastOccupied(batch, [first, second], GAP);
    expect(batch.x + dx).toBe(1686);
  });

  it('stops past a node whose right edge is fractional', () => {
    // 208.0844 + 48 - 48 is 208.08439999999996 in floating point: walking the
    // batch's own x and taking the gap back off lands short of the edge it
    // just stepped past, so that edge is hit again on every step.
    const taken = { x: -147.9156, y: 0, width: 356, height: 232 };
    const dx = shiftRightPastOccupied({ x: -200, y: 0, width: 356, height: 232 }, [taken], GAP);
    expect(-200 + dx).toBeCloseTo(taken.x + taken.width + GAP, 9);
  });

  it('leaves a batch at a fractional x exactly where it is on an empty canvas', () => {
    // (x - 48) + 48 - x is -2.27e-13 here, not 0.
    expect(shiftRightPastOccupied({ ...batch, x: -2027.7354493273058 }, [], GAP)).toBe(0);
  });

  it('counts a node closer than the gap as taking the spot', () => {
    const justBelow = { x: 1000, y: batch.y + batch.height + GAP / 2, width: 288, height: 192 };
    const dx = shiftRightPastOccupied(batch, [justBelow], GAP);
    expect(batch.x + dx).toBe(justBelow.x + justBelow.width + GAP);
  });

  it.each([
    ['below', { x: batch.x, y: batch.y + batch.height + GAP, width: 288, height: 192 }],
    ['above', { x: batch.x, y: batch.y - GAP - 192, width: 288, height: 192 }],
    ['to the left', { x: batch.x - GAP - 288, y: batch.y, width: 288, height: 192 }],
    ['to the right', { x: batch.x + batch.width + GAP, y: batch.y, width: 288, height: 192 }],
  ])('ignores a node exactly the gap away %s', (_side, atGap) => {
    expect(shiftRightPastOccupied(batch, [atGap], GAP)).toBe(0);
  });
});

describe('footprint heights shared by the layout and the canvas', () => {
  it('draws a portrait picture as tall as the node width allows', () => {
    // The shell's 1px border and NodeMediaInset's p-1, on each side.
    const frame = 2 * 1 + 2 * 4;
    expect(mediaNodeHeight(1080, 1920)).toBe(
      ((EMPTY_NODE_SIZE.width - frame) * 1920) / 1080 + frame,
    );
  });

  it('gives an empty text body the minimum height', () => {
    expect(textFootprintHeight('')).toBe(EMPTY_NODE_SIZE.height);
  });

  it('caps a long text body at the height where it starts to clip', () => {
    expect(textFootprintHeight('word '.repeat(2000))).toBe(576);
  });
});
