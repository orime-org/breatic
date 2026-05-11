/**
 * `applyAdjustInPlace` unit tests.
 *
 * We test the pure pixel-loop function instead of the canvas-bound
 * `applyAdjust` so the suite needs zero browser APIs (no canvas, no
 * Image decoding) and runs deterministically in node-only vitest.
 *
 * Cases cover:
 *   - identity (all sliders at 0) leaves pixels unchanged
 *   - positive brightness brightens
 *   - negative brightness darkens
 *   - positive contrast pushes mid-grey toward black/white
 *   - max negative saturation collapses RGB to luma (greyscale)
 *   - clamping at 0 / 255 boundaries (Uint8ClampedArray guarantee)
 */
import { describe, expect, it } from 'vitest';

import { applyAdjustInPlace } from './adjust';

/** Build a 1-pixel RGBA buffer for terse single-pixel tests. */
function pixel(r: number, g: number, b: number, a = 255): Uint8ClampedArray {
  return new Uint8ClampedArray([r, g, b, a]);
}

function rgb(buf: Uint8ClampedArray): [number, number, number] {
  return [buf[0], buf[1], buf[2]];
}

describe('applyAdjustInPlace', () => {
  it('is identity when all sliders are 0', () => {
    const buf = pixel(120, 80, 200);
    applyAdjustInPlace(buf, { brightness: 0, contrast: 0, saturation: 0 });
    expect(rgb(buf)).toEqual([120, 80, 200]);
  });

  it('preserves alpha', () => {
    const buf = pixel(120, 80, 200, 128);
    applyAdjustInPlace(buf, { brightness: 30, contrast: 20, saturation: -20 });
    expect(buf[3]).toBe(128);
  });

  it('positive brightness brightens every channel', () => {
    const buf = pixel(100, 100, 100);
    applyAdjustInPlace(buf, { brightness: 25, contrast: 0, saturation: 0 });
    // brightness 25 ⇒ +63.5 ⇒ ~163 (rounded by Uint8ClampedArray write)
    expect(buf[0]).toBeGreaterThan(100);
    expect(buf[1]).toBe(buf[0]);
    expect(buf[2]).toBe(buf[0]);
  });

  it('negative brightness darkens every channel', () => {
    const buf = pixel(100, 100, 100);
    applyAdjustInPlace(buf, { brightness: -25, contrast: 0, saturation: 0 });
    expect(buf[0]).toBeLessThan(100);
  });

  it('positive contrast pushes mid-grey away from 128', () => {
    const dark = pixel(64, 64, 64);
    const light = pixel(192, 192, 192);
    applyAdjustInPlace(dark, { brightness: 0, contrast: 50, saturation: 0 });
    applyAdjustInPlace(light, { brightness: 0, contrast: 50, saturation: 0 });
    // 64 → darker; 192 → lighter when contrast ramps up.
    expect(dark[0]).toBeLessThan(64);
    expect(light[0]).toBeGreaterThan(192);
  });

  it('max negative saturation collapses RGB to luma', () => {
    const buf = pixel(200, 50, 100);
    applyAdjustInPlace(buf, { brightness: 0, contrast: 0, saturation: -50 });
    // Rec. 601 luma: 0.299*200 + 0.587*50 + 0.114*100 ≈ 100.6
    // After saturation -50 → saturation factor 0 → every channel = luma.
    expect(buf[0]).toBe(buf[1]);
    expect(buf[1]).toBe(buf[2]);
    expect(buf[0]).toBeGreaterThanOrEqual(100);
    expect(buf[0]).toBeLessThanOrEqual(101);
  });

  it('positive saturation pushes colors away from luma', () => {
    const buf = pixel(180, 100, 100);
    const original = rgb(buf);
    applyAdjustInPlace(buf, { brightness: 0, contrast: 0, saturation: 30 });
    // Red channel is above luma → should increase; green/blue below luma → decrease.
    expect(buf[0]).toBeGreaterThan(original[0]);
    expect(buf[1]).toBeLessThan(original[1]);
  });

  it('clamps overflow at 255', () => {
    const buf = pixel(250, 250, 250);
    applyAdjustInPlace(buf, { brightness: 50, contrast: 0, saturation: 0 });
    expect(buf[0]).toBe(255);
    expect(buf[1]).toBe(255);
    expect(buf[2]).toBe(255);
  });

  it('clamps underflow at 0', () => {
    const buf = pixel(10, 10, 10);
    applyAdjustInPlace(buf, { brightness: -50, contrast: 0, saturation: 0 });
    expect(buf[0]).toBe(0);
    expect(buf[1]).toBe(0);
    expect(buf[2]).toBe(0);
  });

  it('processes a multi-pixel buffer in one call', () => {
    const buf = new Uint8ClampedArray([
      100, 100, 100, 255,
      150, 50, 200, 255,
    ]);
    applyAdjustInPlace(buf, { brightness: 10, contrast: 0, saturation: 0 });
    // Brightness +10 → +25.4 per channel.
    expect(buf[0]).toBeGreaterThan(100);
    expect(buf[3]).toBe(255);
    expect(buf[4]).toBeGreaterThan(150);
    expect(buf[7]).toBe(255);
  });
});
