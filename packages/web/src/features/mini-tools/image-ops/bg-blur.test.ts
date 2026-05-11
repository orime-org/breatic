/**
 * `applyBgBlurInPlace` unit tests.
 *
 * Same node-only strategy as `adjust.test.ts` / `filter.test.ts` —
 * verify pixel math directly, no canvas needed.
 *
 * Blur correctness is awkward to test exactly (3-pass box blur with
 * boundary clamping has fiddly arithmetic), so we test *properties*:
 * radius 0 = identity, uniform image stays uniform, alpha is preserved,
 * blur averages adjacent pixels, etc.
 */
import { describe, expect, it } from 'vitest';

import { applyBgBlurInPlace } from './bg-blur';

/** Build an `w × h` solid-color RGBA buffer. */
function solid(w: number, h: number, r: number, g: number, b: number, a = 255): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    buf[i + 3] = a;
  }
  return buf;
}

describe('applyBgBlurInPlace', () => {
  it('is identity when radius is 0', () => {
    const buf = new Uint8ClampedArray([
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 255, 255,
      128, 128, 128, 255,
    ]);
    const copy = new Uint8ClampedArray(buf);
    applyBgBlurInPlace(buf, 2, 2, { radius: 0, preserveSubject: true });
    expect(Array.from(buf)).toEqual(Array.from(copy));
  });

  it('uniform image stays uniform at any radius', () => {
    const buf = solid(8, 8, 100, 150, 200);
    applyBgBlurInPlace(buf, 8, 8, { radius: 50, preserveSubject: false });
    for (let i = 0; i < buf.length; i += 4) {
      expect(buf[i]).toBeGreaterThanOrEqual(99);
      expect(buf[i]).toBeLessThanOrEqual(101);
      expect(buf[i + 1]).toBeGreaterThanOrEqual(149);
      expect(buf[i + 1]).toBeLessThanOrEqual(151);
      expect(buf[i + 2]).toBeGreaterThanOrEqual(199);
      expect(buf[i + 2]).toBeLessThanOrEqual(201);
    }
  });

  it('preserves alpha untouched per-pixel', () => {
    const buf = new Uint8ClampedArray(4 * 4 * 4);
    for (let i = 0; i < buf.length; i += 4) {
      buf[i] = 100;
      buf[i + 1] = 100;
      buf[i + 2] = 100;
      buf[i + 3] = (i / 4) * 10 + 50; // varying alpha
    }
    const alphasBefore = Array.from({ length: 16 }, (_, k) => buf[k * 4 + 3]);
    applyBgBlurInPlace(buf, 4, 4, { radius: 50, preserveSubject: true });
    const alphasAfter = Array.from({ length: 16 }, (_, k) => buf[k * 4 + 3]);
    expect(alphasAfter).toEqual(alphasBefore);
  });

  it('averages adjacent pixels so a hard edge softens', () => {
    // 4×1 image: black-black-white-white. After blur, the middle pixels
    // should converge toward mid-grey rather than stay pure black/white.
    const buf = new Uint8ClampedArray([
      0, 0, 0, 255,
      0, 0, 0, 255,
      255, 255, 255, 255,
      255, 255, 255, 255,
    ]);
    applyBgBlurInPlace(buf, 4, 1, { radius: 30, preserveSubject: false });
    // Middle two pixels should be somewhere in mid-tone, not 0 or 255.
    expect(buf[4]).toBeGreaterThan(0);
    expect(buf[4]).toBeLessThan(255);
    expect(buf[8]).toBeGreaterThan(0);
    expect(buf[8]).toBeLessThan(255);
  });

  it('larger radius blurs more aggressively', () => {
    function mkEdge(): Uint8ClampedArray {
      return new Uint8ClampedArray([
        0, 0, 0, 255,
        0, 0, 0, 255,
        255, 255, 255, 255,
        255, 255, 255, 255,
      ]);
    }
    const small = mkEdge();
    const big = mkEdge();
    applyBgBlurInPlace(small, 4, 1, { radius: 10, preserveSubject: false });
    applyBgBlurInPlace(big, 4, 1, { radius: 80, preserveSubject: false });
    // The bigger radius should mix the channels more — the dark pixel
    // gets brighter, the bright one gets darker.
    expect(big[0]).toBeGreaterThan(small[0]);
    expect(big[12]).toBeLessThan(small[12]);
  });

  it('`preserveSubject` is honored as a no-op in V1 (same output either way)', () => {
    function mkEdge(): Uint8ClampedArray {
      return new Uint8ClampedArray([
        0, 0, 0, 255,
        0, 0, 0, 255,
        255, 255, 255, 255,
        255, 255, 255, 255,
      ]);
    }
    const withFlag = mkEdge();
    const withoutFlag = mkEdge();
    applyBgBlurInPlace(withFlag, 4, 1, { radius: 50, preserveSubject: true });
    applyBgBlurInPlace(withoutFlag, 4, 1, { radius: 50, preserveSubject: false });
    expect(Array.from(withFlag)).toEqual(Array.from(withoutFlag));
  });

  it('vertical pass propagates brightness — middle row stays brighter than the edges', () => {
    // 21×21 with middle row (y=10) full white. With a small kernel
    // (radius 4 → pixel_radius 2 → 5×5 kernel, ~15-pixel effective
    // spread after 3 passes), the bright row should still dominate
    // its locale while rows 10+ away decay to nearly 0.
    const w = 21;
    const h = 21;
    const buf = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < buf.length; i += 4) {
      buf[i + 3] = 255;
    }
    const middleY = 10;
    for (let x = 0; x < w; x++) {
      const idx = (middleY * w + x) * 4;
      buf[idx] = 255;
      buf[idx + 1] = 255;
      buf[idx + 2] = 255;
    }
    applyBgBlurInPlace(buf, w, h, { radius: 4, preserveSubject: false });
    const middleAfter = buf[(middleY * w + 10) * 4];
    const farAfter = buf[(0 * w + 10) * 4];
    expect(middleAfter).toBeGreaterThan(farAfter);
    expect(farAfter).toBeLessThan(20);
  });
});
