/**
 * `resolveSourceRect` unit tests — verify the clamp + minimum-size
 * guard without needing a canvas. `applyCrop` itself sits behind canvas
 * APIs that jsdom doesn't implement, so its smoke is left for browser-
 * level verification.
 */
import { describe, it, expect } from 'vitest';

import { resolveSourceRect } from './crop';

describe('resolveSourceRect', () => {
  it('maps a full-image rect to source-pixel dimensions', () => {
    const rect = resolveSourceRect(800, 600, { x: 0, y: 0, width: 1, height: 1 });
    expect(rect).toEqual({ sx: 0, sy: 0, sw: 800, sh: 600 });
  });

  it('maps a centered half-size rect', () => {
    const rect = resolveSourceRect(800, 600, {
      x: 0.25,
      y: 0.25,
      width: 0.5,
      height: 0.5,
    });
    expect(rect).toEqual({ sx: 200, sy: 150, sw: 400, sh: 300 });
  });

  it('clamps negative origins to zero and shrinks width accordingly', () => {
    const rect = resolveSourceRect(100, 100, {
      x: -0.1,
      y: -0.1,
      width: 0.5,
      height: 0.5,
    });
    expect(rect).toEqual({ sx: 0, sy: 0, sw: 50, sh: 50 });
  });

  it('clamps origin + size to stay inside [0, 1]', () => {
    const rect = resolveSourceRect(100, 100, {
      x: 0.8,
      y: 0.8,
      width: 0.5, // would overshoot to 1.3
      height: 0.5,
    });
    // x: 0.8 → width clamped to 0.2 → 20px wide starting at sx=80.
    expect(rect).toEqual({ sx: 80, sy: 80, sw: 20, sh: 20 });
  });

  it('throws when the resolved width is below the minimum', () => {
    expect(() =>
      resolveSourceRect(100, 100, { x: 0, y: 0, width: 0.01, height: 1 }),
    ).toThrow(/too small/i);
  });

  it('throws when the resolved height is below the minimum', () => {
    expect(() =>
      resolveSourceRect(100, 100, { x: 0, y: 0, width: 1, height: 0.01 }),
    ).toThrow(/too small/i);
  });

  it('rounds fractional pixels to the nearest integer', () => {
    // 0.333 * 100 = 33.3 → rounds to 33; 0.5 * 100 = 50 → rounds to 50.
    const rect = resolveSourceRect(100, 100, {
      x: 0.333,
      y: 0.5,
      width: 0.333,
      height: 0.25,
    });
    expect(rect.sx).toBe(33);
    expect(rect.sy).toBe(50);
    expect(rect.sw).toBe(33);
    expect(rect.sh).toBe(25);
  });
});
