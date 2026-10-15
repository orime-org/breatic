// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The picture adjust's filters (inner#1303 §6.1), run on plain pixel arrays
 * through each filter's 2D path. The WebGL path is checked in the browser.
 */

import { describe, it, expect } from 'vitest';

import { ADJUST_RANGES, defaultAdjustValue, type AdjustValue } from '@breatic/shared';

import { adjustFilters, adjustPixels } from '@web/spaces/canvas/mini-tool/adjust-filters';

/** A picture's pixels. */
interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * A test picture with gradients and edges in every channel.
 * @param size - Its side in pixels.
 * @returns Its pixels.
 */
function picture(size: number): Pixels {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const u = x / size;
      const v = y / size;
      data[i] = 40 + 170 * u;
      data[i + 1] = ((x * 8) / size) % 2 < 1 ? 70 : 180;
      data[i + 2] = 60 + 150 * v;
      data[i + 3] = 255;
    }
  }
  return { data, width: size, height: size };
}

/**
 * Run the adjust on a copy of a picture.
 * @param source - The picture.
 * @param value - The sliders that move.
 * @param seed - The grain's seed.
 * @param sourceSide - The side of the picture the adjust is for, when this is a smaller draw of it.
 * @returns The adjusted copy.
 */
function adjusted(source: Pixels, value: Partial<AdjustValue>, seed = 7, sourceSide = source.width): Pixels {
  const copy = { ...source, data: new Uint8ClampedArray(source.data) };
  adjustPixels(copy, { ...defaultAdjustValue, ...value }, seed, { width: sourceSide, height: sourceSide });
  return copy;
}

/**
 * The largest difference between two pictures' channels.
 * @param a - One picture.
 * @param b - The other.
 * @returns The difference.
 */
function maxDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let most = 0;
  for (let i = 0; i < a.length; i++) most = Math.max(most, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  return most;
}

/**
 * A picture shrunk to half its side by averaging each 2×2 block.
 * @param source - The picture.
 * @returns The half-size picture.
 */
function half(source: Pixels): Pixels {
  const width = source.width / 2;
  const data = new Uint8ClampedArray(width * width * 4);
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
          sum += source.data[((y * 2 + dy) * source.width + x * 2 + dx) * 4 + c] ?? 0;
        }
        data[(y * width + x) * 4 + c] = sum / 4;
      }
    }
  }
  return { data, width, height: width };
}

describe('adjustPixels', () => {
  it('leaves the picture as it was at zero', () => {
    const source = picture(32);
    expect(maxDiff(adjusted(source, {}).data, source.data)).toBe(0);
  });

  it.each(Object.keys(ADJUST_RANGES) as (keyof AdjustValue)[])('changes the picture at both ends of %s', (field) => {
    const source = picture(32);
    const { min, max } = ADJUST_RANGES[field];
    for (const end of [min, max].filter((value) => value !== 0)) {
      expect(maxDiff(adjusted(source, { [field]: end }).data, source.data), `${field}=${end}`).toBeGreaterThan(0);
    }
  });

  // A radius kept as a share of the width falls under one pixel on a narrow
  // picture (sharpness moved this one by 2 levels); the export reaches at
  // least one of its own pixels, as ffmpeg's smallest unsharp matrix does.
  it.each(['sharpness', 'clarity'] as const)(
    'changes a picture narrower than 512 px clearly at full %s',
    (field) => {
      const source = picture(64);
      expect(maxDiff(adjusted(source, { [field]: 100 }).data, source.data)).toBeGreaterThan(20);
    },
  );

  // FabricImage.applyFilters drops every pass whose isNeutralState() is true
  // before it runs the rest (fabric dist/index.mjs:19588), and the preview and
  // the export both run through it.
  it.each(Object.keys(ADJUST_RANGES) as (keyof AdjustValue)[])(
    'builds no pass for %s that Fabric would skip as neutral',
    (field) => {
      const { min, max } = ADJUST_RANGES[field];
      for (const end of [min, max].filter((value) => value !== 0)) {
        const passes = adjustFilters({ ...defaultAdjustValue, [field]: end }, 7, { width: 64, height: 64 });
        expect(passes.length, `${field}=${end}`).toBeGreaterThan(0);
        for (const pass of passes) expect(pass.isNeutralState(), `${field}=${end} ${pass.type}`).toBe(false);
      }
    },
  );

  it('lays the same grain twice for the same seed', () => {
    const source = picture(32);
    expect(maxDiff(adjusted(source, { grain: 80 }, 11).data, adjusted(source, { grain: 80 }, 11).data)).toBe(0);
  });

  // The result is shown at the preview's size by the browser averaging its
  // pixels, which thins independent grain by the side it shrinks by.
  it.each([2, 4])('lays grain as strong in a preview drawn 1/%i of the source as in the export shown at that size', (k) => {
    const side = 128;
    const grey = (size: number): Pixels => {
      const data = new Uint8ClampedArray(size * size * 4).fill(128);
      for (let i = 3; i < data.length; i += 4) data[i] = 255;
      return { data, width: size, height: size };
    };
    let shown = adjusted(grey(side), { grain: 100 });
    for (let s = k; s > 1; s /= 2) shown = half(shown);
    const preview = adjusted(grey(side / k), { grain: 100 }, 7, side);
    const spread = (pixels: Pixels, channel: number): number => {
      const values = Array.from({ length: pixels.width * pixels.height }, (_, i) => pixels.data[i * 4 + channel] ?? 0);
      const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
      return Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length);
    };
    for (let channel = 0; channel < 3; channel++) {
      const ratio = spread(preview, channel) / spread(shown, channel);
      expect(ratio, `channel ${channel}`).toBeGreaterThan(0.8);
      expect(ratio, `channel ${channel}`).toBeLessThan(1.25);
    }
  });

  // Drawn smaller than the source, a tap lands between a subject pixel and a
  // transparent one; the transparent one must add nothing there either.
  it.each([1, 4].flatMap((shrink) => [{ noiseReduction: 100 }, { sharpness: 100 }, { clarity: 100 }].map((value) => ({ shrink, value }))))(
    'keeps a cut-out edge its own colour drawn at 1/$shrink with $value',
    ({ shrink, value }) => {
      const width = 40;
      const data = new Uint8ClampedArray(width * 8 * 4);
      for (let y = 0; y < 8; y++) for (let x = 20; x < width; x++) data.set([200, 60, 40, 255], (y * width + x) * 4);
      const out = { data, width, height: 8 };
      adjustPixels(out, { ...defaultAdjustValue, ...value }, 7, { width: width * shrink, height: 8 * shrink });
      // An inside pixel, out of every kernel's reach of the edge, is what the whole subject turns into.
      const inside = (4 * width + 32) * 4;
      for (let x = 20; x < width; x++) {
        const i = (4 * width + x) * 4;
        const gap = Math.max(...[0, 1, 2].map((k) => Math.abs((out.data[i + k] ?? 0) - (out.data[inside + k] ?? 0))));
        expect(gap, `x=${x}`).toBeLessThanOrEqual(2);
        expect(out.data[i + 3]).toBe(255);
      }
      expect(out.data[(4 * width + 10) * 4 + 3]).toBe(0);
    },
  );

  // Fabric's 2D backend hands the filters a real ImageData, whose width and
  // height are getters on its prototype rather than fields of its own.
  it.each([{ noiseReduction: 100 }, { sharpness: 100 }, { clarity: 100 }])(
    'reads an ImageData-shaped picture the same as a plain one with %o',
    (value) => {
      class Shaped {
        readonly #width: number;
        readonly #height: number;
        constructor(
          readonly data: Uint8ClampedArray,
          width: number,
          height: number,
        ) {
          this.#width = width;
          this.#height = height;
        }
        get width(): number {
          return this.#width;
        }
        get height(): number {
          return this.#height;
        }
      }
      const source = picture(32);
      const shaped = new Shaped(new Uint8ClampedArray(source.data), 32, 32);
      adjustPixels(shaped, { ...defaultAdjustValue, ...value }, 7);
      expect(maxDiff(shaped.data, adjusted(source, value).data)).toBe(0);
    },
  );

  it.each(['sharpness', 'clarity'] as const)('looks the same at two resolutions with %s', (field) => {
    // The small one is a preview of the large: it draws the large picture's effect.
    const small = adjusted(picture(64), { [field]: 80 }, 7, 128);
    const large = half(adjusted(picture(128), { [field]: 80 }));
    // Averaging a sharpened or grainy picture blurs it a little; what has to
    // hold is that the effect is the same size, not that every pixel matches.
    const effectSmall = maxDiff(small.data, picture(64).data);
    const effectLarge = maxDiff(large.data, half(picture(128)).data);
    expect(Math.abs(effectSmall - effectLarge)).toBeLessThan(effectSmall * 0.5);
  });
});
