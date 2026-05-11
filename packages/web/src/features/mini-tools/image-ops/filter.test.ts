/**
 * `applyFilterInPlace` unit tests.
 *
 * Same node-only test strategy as `adjust.test.ts` — pure pixel math,
 * no canvas. One test per preset + an intensity-blend sanity check.
 */
import { describe, expect, it } from 'vitest';

import { applyFilterInPlace, type FilterPreset } from './filter';

function pixel(r: number, g: number, b: number, a = 255): Uint8ClampedArray {
  return new Uint8ClampedArray([r, g, b, a]);
}

function rgb(buf: Uint8ClampedArray): [number, number, number] {
  return [buf[0], buf[1], buf[2]];
}

describe('applyFilterInPlace', () => {
  it("is identity when preset is 'none'", () => {
    const buf = pixel(120, 80, 200);
    applyFilterInPlace(buf, { preset: 'none', intensity: 100 });
    expect(rgb(buf)).toEqual([120, 80, 200]);
  });

  it('is identity when intensity is 0 (regardless of preset)', () => {
    const buf = pixel(120, 80, 200);
    applyFilterInPlace(buf, { preset: 'sepia', intensity: 0 });
    expect(rgb(buf)).toEqual([120, 80, 200]);
  });

  it('preserves alpha across every preset', () => {
    const presets: FilterPreset[] = ['mono', 'sepia', 'film', 'cool', 'warm'];
    for (const preset of presets) {
      const buf = pixel(120, 80, 200, 128);
      applyFilterInPlace(buf, { preset, intensity: 100 });
      expect(buf[3]).toBe(128);
    }
  });

  it('mono collapses RGB to luma (R = G = B after)', () => {
    const buf = pixel(200, 50, 100);
    applyFilterInPlace(buf, { preset: 'mono', intensity: 100 });
    expect(buf[0]).toBe(buf[1]);
    expect(buf[1]).toBe(buf[2]);
    // Rec. 601 luma ≈ 0.299*200 + 0.587*50 + 0.114*100 ≈ 100.6
    expect(buf[0]).toBeGreaterThanOrEqual(100);
    expect(buf[0]).toBeLessThanOrEqual(101);
  });

  it('sepia pushes mid-grey toward warm brown', () => {
    const buf = pixel(128, 128, 128);
    applyFilterInPlace(buf, { preset: 'sepia', intensity: 100 });
    // Sepia matrix on grey: R > G > B (warm brown bias).
    expect(buf[0]).toBeGreaterThan(buf[1]);
    expect(buf[1]).toBeGreaterThan(buf[2]);
  });

  it('cool shifts mid-grey toward blue', () => {
    const buf = pixel(128, 128, 128);
    applyFilterInPlace(buf, { preset: 'cool', intensity: 100 });
    expect(buf[0]).toBeLessThan(128); // red pulled down
    expect(buf[2]).toBeGreaterThan(128); // blue pushed up
  });

  it('warm shifts mid-grey toward orange', () => {
    const buf = pixel(128, 128, 128);
    applyFilterInPlace(buf, { preset: 'warm', intensity: 100 });
    expect(buf[0]).toBeGreaterThan(128); // red pushed up
    expect(buf[2]).toBeLessThan(128); // blue pulled down
  });

  it('film lifts shadows', () => {
    const buf = pixel(0, 0, 0);
    applyFilterInPlace(buf, { preset: 'film', intensity: 100 });
    // Black source: 0 * 0.9 + lift > 0 on R and G channels.
    expect(buf[0]).toBeGreaterThan(0);
    expect(buf[1]).toBeGreaterThan(0);
  });

  it('intensity 50 produces a midpoint between source and full preset', () => {
    const at100 = pixel(128, 128, 128);
    const at50 = pixel(128, 128, 128);
    applyFilterInPlace(at100, { preset: 'cool', intensity: 100 });
    applyFilterInPlace(at50, { preset: 'cool', intensity: 50 });
    // Source red = 128. Full cool → 110. Half-cool → (128 + 110) / 2 = 119.
    expect(Math.abs(at50[0] - (128 + at100[0]) / 2)).toBeLessThan(1);
  });

  it('processes multi-pixel buffer correctly', () => {
    const buf = new Uint8ClampedArray([
      200, 50, 100, 255,
      50, 200, 100, 255,
    ]);
    applyFilterInPlace(buf, { preset: 'mono', intensity: 100 });
    // Each pixel collapsed to its own luma; alphas preserved.
    expect(buf[0]).toBe(buf[1]);
    expect(buf[1]).toBe(buf[2]);
    expect(buf[3]).toBe(255);
    expect(buf[4]).toBe(buf[5]);
    expect(buf[5]).toBe(buf[6]);
    expect(buf[7]).toBe(255);
    // Two pixels should have different luma since their RGB ordering differs.
    expect(buf[0]).not.toBe(buf[4]);
  });

  it('clamps overflow at 255 / underflow at 0', () => {
    const bright = pixel(250, 250, 250);
    applyFilterInPlace(bright, { preset: 'warm', intensity: 100 });
    // R = 250 + 20 = 270 → clamped to 255.
    expect(bright[0]).toBe(255);

    const dark = pixel(5, 5, 5);
    applyFilterInPlace(dark, { preset: 'cool', intensity: 100 });
    // R = 5 - 18 → clamped to 0.
    expect(dark[0]).toBe(0);
  });
});
