// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A slider means the same on a picture and a video (inner#1303 §6.1): the
 * picture's filters are run on the frames ffmpeg was given, and compared with
 * what ffmpeg made of the video adjust's own filter string
 * (`buildAdjustVideoFilter`). The fixture holds ffmpeg's output; its
 * generator is kept with the design's demos. ffmpeg works in YUV 4:2:0 and
 * back, which moves a colour by a few levels on its own; the tolerances allow
 * for that and nothing more.
 */

import { describe, expect, it } from 'vitest';

import { defaultAdjustValue, type AdjustValue } from '@breatic/shared';

import { adjustPixels } from '@web/spaces/canvas/mini-tool/adjust-filters';

import fixture from './fixtures/adjust-ffmpeg.json';

/** A picture's pixels. */
interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * A picture of one colour.
 * @param rgb - The colour.
 * @param width - Its width.
 * @param height - Its height.
 * @returns Its pixels.
 */
function solid(rgb: readonly number[], width: number, height: number): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0, 255], i * 4);
  return { data, width, height };
}

/**
 * A colour written as six hex digits.
 * @param hex - The digits.
 * @returns Its channels.
 */
function rgbOf(hex: string): number[] {
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

/**
 * Run the adjust on a picture at its own size.
 * @param pixels - The picture, changed in place.
 * @param value - The sliders that move.
 * @returns The picture.
 */
function adjust(pixels: Pixels, value: Partial<AdjustValue>): Pixels {
  adjustPixels(pixels, { ...defaultAdjustValue, ...value }, 1, pixels);
  return pixels;
}

/**
 * One pixel's channels.
 * @param pixels - The picture.
 * @param x - Its x.
 * @param y - Its y.
 * @returns Its red, green and blue.
 */
function at(pixels: Pixels, x: number, y: number): number[] {
  const i = (y * pixels.width + x) * 4;
  return [pixels.data[i] ?? 0, pixels.data[i + 1] ?? 0, pixels.data[i + 2] ?? 0];
}

/**
 * The largest difference between two colours.
 * @param a - One.
 * @param b - The other.
 * @returns The difference.
 */
function gap(a: readonly number[], b: readonly number[]): number {
  return Math.max(...a.map((v, k) => Math.abs(v - (b[k] ?? 0))));
}

describe('the picture adjust against ffmpeg', () => {
  describe.each(fixture.colors)('colour with $filter', ({ value, pixels }) => {
    it.each(Object.entries(pixels))('turns %s into what ffmpeg makes of it', (hex, expected) => {
      const out = adjust(solid(rgbOf(hex), 16, 16), value);
      // A colour's trip through 4:2:0 alone moves it by up to 3 levels.
      expect(gap(at(out, 8, 8), expected)).toBeLessThanOrEqual(5);
    });
  });

  // A 4:2:0 frame holds one chroma sample per 2×2 block, so ffmpeg moves a
  // coloured edge's chroma a pair of columns at a time; the picture holds
  // chroma per pixel. Both rows are taken a pair of columns at a time; a
  // colour's trip through 4:2:0 alone moves it by up to 4 levels.
  it.each(fixture.edges)('draws a $left|$right edge as ffmpeg does with $filter', ({ value, left, right, row }) => {
    const edge = solid(rgbOf(left), 64, 16);
    for (let y = 0; y < 16; y++) for (let x = 32; x < 64; x++) edge.data.set(rgbOf(right), (y * 64 + x) * 4);
    const out = adjust(edge, value);
    const got = Array.from({ length: 64 }, (_, x) => at(out, x, 8));
    const pairs = (line: readonly (readonly number[])[]): number[][] =>
      Array.from({ length: 32 }, (_, p) => [0, 1, 2].map((k) => ((line[2 * p]?.[k] ?? 0) + (line[2 * p + 1]?.[k] ?? 0)) / 2));
    const theirs = pairs(row);
    const worst = Math.max(...pairs(got).map((rgb, p) => gap(rgb, theirs[p] ?? [])));
    expect(worst).toBeLessThanOrEqual(left === '404040' ? 8 : 10);
  });

  it.each(fixture.vignettes)('darkens $color as ffmpeg does with $filter', ({ value, color, points }) => {
    const out = adjust(solid(rgbOf(color), 320, 180), value);
    for (const { x, y, rgb } of points) expect(gap(at(out, x, y), rgb), `${x},${y}`).toBeLessThanOrEqual(6);
  });

  it.each(fixture.grains)('lays grain like ffmpeg with $filter', ({ value, std, corr }) => {
    const out = adjust(solid([128, 128, 128], 64, 64), value);
    const d: number[][] = [[], [], []];
    for (let i = 0; i < 64 * 64; i++) for (let k = 0; k < 3; k++) d[k]?.push((out.data[i * 4 + k] ?? 0) - 128);
    const mean = (a: number[]): number => a.reduce((s, x) => s + x, 0) / a.length;
    const spread = (a: number[]): number => Math.sqrt(mean(a.map((x) => (x - mean(a)) ** 2)));
    const together = (a: number[], b: number[]): number =>
      mean(a.map((x, i) => (x - mean(a)) * ((b[i] ?? 0) - mean(b)))) / (spread(a) * spread(b));
    const [r = [], g = [], b = []] = d;
    for (const [k, channel] of [r, g, b].entries()) {
      expect(spread(channel) / (std[k] ?? 1), `channel ${k}`).toBeGreaterThan(0.85);
      expect(spread(channel) / (std[k] ?? 1), `channel ${k}`).toBeLessThan(1.15);
    }
    expect(Math.abs(together(r, g) - corr.rg)).toBeLessThan(0.15);
    expect(Math.abs(together(r, b) - corr.rb)).toBeLessThan(0.15);
    expect(Math.abs(together(g, b) - corr.gb)).toBeLessThan(0.15);
  });
});
