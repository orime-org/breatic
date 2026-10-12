// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The picture adjust's filters (inner#1303 §6.1), run on plain pixel arrays
 * through each filter's 2D path. The WebGL path is checked in the browser.
 */

import { describe, it, expect } from 'vitest';

import { ADJUST_RANGES, defaultAdjustValue, type AdjustValue } from '@breatic/shared';

import { adjustPixels } from '@web/spaces/canvas/mini-tool/adjust-filters';

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
 * @returns The adjusted copy.
 */
function adjusted(source: Pixels, value: Partial<AdjustValue>, seed = 7): Pixels {
  const copy = { ...source, data: new Uint8ClampedArray(source.data) };
  adjustPixels(copy, { ...defaultAdjustValue, ...value }, seed);
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

  it('lays the same grain twice for the same seed', () => {
    const source = picture(32);
    expect(maxDiff(adjusted(source, { grain: 80 }, 11).data, adjusted(source, { grain: 80 }, 11).data)).toBe(0);
  });

  it.each(['sharpness', 'clarity', 'grain'] as const)('looks the same at two resolutions with %s', (field) => {
    const small = adjusted(picture(64), { [field]: 80 });
    const large = half(adjusted(picture(128), { [field]: 80 }));
    // Averaging a sharpened or grainy picture blurs it a little; what has to
    // hold is that the effect is the same size, not that every pixel matches.
    const effectSmall = maxDiff(small.data, picture(64).data);
    const effectLarge = maxDiff(large.data, half(picture(128)).data);
    expect(Math.abs(effectSmall - effectLarge)).toBeLessThan(effectSmall * 0.5);
  });
});
