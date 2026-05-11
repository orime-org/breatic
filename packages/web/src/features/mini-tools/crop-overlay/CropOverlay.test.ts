/**
 * `applyDrag` unit tests — verify rect resize / move math without
 * needing to spin up jsdom + mouse events. The geometry is the
 * fragile part (corners adjust two edges, edges adjust one, `move`
 * translates without resize) so it gets its own table-driven suite.
 */
import { describe, it, expect } from 'vitest';

import { applyDrag } from './CropOverlay';

const START = { x: 0.2, y: 0.2, width: 0.6, height: 0.6 };

describe('applyDrag', () => {
  it('move translates the whole rect', () => {
    expect(applyDrag(START, 'move', 0.1, 0.1)).toEqual({
      x: 0.3,
      y: 0.3,
      width: 0.6,
      height: 0.6,
    });
  });

  it('move clamps so the rect stays inside [0,1]', () => {
    // Try to drag well past the right + bottom edges.
    expect(applyDrag(START, 'move', 1, 1)).toEqual({
      x: 0.4, // 1 - width
      y: 0.4,
      width: 0.6,
      height: 0.6,
    });
  });

  it('se corner enlarges from the bottom-right', () => {
    const r = applyDrag(START, 'se', 0.1, 0.05);
    expect(r.x).toBeCloseTo(0.2);
    expect(r.y).toBeCloseTo(0.2);
    expect(r.width).toBeCloseTo(0.7);
    expect(r.height).toBeCloseTo(0.65);
  });

  it('nw corner pulls top-left toward the cursor', () => {
    const r = applyDrag(START, 'nw', -0.1, -0.1);
    expect(r.x).toBeCloseTo(0.1);
    expect(r.y).toBeCloseTo(0.1);
    expect(r.width).toBeCloseTo(0.7);
    expect(r.height).toBeCloseTo(0.7);
  });

  it('n edge moves only the top edge', () => {
    const r = applyDrag(START, 'n', 0.5, -0.1);
    // dx is ignored for top-edge drags
    expect(r.x).toBeCloseTo(0.2);
    expect(r.width).toBeCloseTo(0.6);
    expect(r.y).toBeCloseTo(0.1);
    expect(r.height).toBeCloseTo(0.7);
  });

  it('e edge moves only the right edge', () => {
    const r = applyDrag(START, 'e', 0.1, 0.5);
    // dy is ignored for right-edge drags
    expect(r.y).toBeCloseTo(0.2);
    expect(r.height).toBeCloseTo(0.6);
    expect(r.x).toBeCloseTo(0.2);
    expect(r.width).toBeCloseTo(0.7);
  });

  it('enforces minimum width when shrinking from the east', () => {
    // Try to collapse the right edge well past the left edge.
    const r = applyDrag(START, 'e', -1, 0);
    expect(r.x).toBeCloseTo(0.2);
    expect(r.width).toBeCloseTo(0.05); // MIN_REL_SIZE
  });

  it('enforces minimum height when shrinking from the south', () => {
    const r = applyDrag(START, 's', 0, -1);
    expect(r.y).toBeCloseTo(0.2);
    expect(r.height).toBeCloseTo(0.05);
  });

  it('keeps the right edge inside [0,1] when extending past 1', () => {
    const r = applyDrag(START, 'e', 1, 0);
    expect(r.x + r.width).toBeCloseTo(1);
  });

  it('keeps the left edge inside [0,1] when extending past 0', () => {
    const r = applyDrag(START, 'w', -1, 0);
    expect(r.x).toBeCloseTo(0);
  });
});
