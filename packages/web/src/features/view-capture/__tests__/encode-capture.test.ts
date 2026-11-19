// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { encodeWithin, fitEdge, type Encoder } from '@web/features/view-capture/encode-capture';

/**
 * An encoder whose output size follows the pixels and the quality, the way a
 * real one does; `webp` false behaves like Safari, which answers PNG for WebP.
 * @param webp - Whether WebP is supported.
 * @returns The encoder and every call it took.
 */
function fakeEncoder(webp = true): { encode: Encoder; calls: Array<{ type: string; quality: number; w: number; h: number }> } {
  const calls: Array<{ type: string; quality: number; w: number; h: number }> = [];
  const encode: Encoder = async (source, type, quality) => {
    calls.push({ type, quality, w: source.width, h: source.height });
    const actual = type === 'image/webp' && !webp ? 'image/png' : type;
    return new Blob([new Uint8Array(Math.round(source.width * source.height * quality))], { type: actual });
  };
  return { encode, calls };
}

describe('fitEdge', () => {
  it('keeps a size within the edge and scales a larger one by its longest side', () => {
    expect(fitEdge(800, 600, 1568)).toEqual({ width: 800, height: 600 });
    expect(fitEdge(3136, 1000, 1568)).toEqual({ width: 1568, height: 500 });
  });

  it('never exceeds the edge and keeps the aspect', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10000 }), fc.integer({ min: 1, max: 10000 }), fc.integer({ min: 16, max: 4096 }), (w, h, edge) => {
        const out = fitEdge(w, h, edge);
        expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(edge);
        expect(out.width).toBeGreaterThanOrEqual(1);
        expect(out.height).toBeGreaterThanOrEqual(1);
      }),
    );
  });
});

describe('encodeWithin', () => {
  it('answers WebP at the top quality when it fits', async () => {
    const { encode, calls } = fakeEncoder();
    const blob = await encodeWithin({ width: 100, height: 100 }, 1_000_000, encode, (w, h) => ({ width: w, height: h }));
    expect(blob.type).toBe('image/webp');
    expect(calls).toHaveLength(1);
  });

  it('turns to JPEG where the browser cannot write WebP', async () => {
    const { encode } = fakeEncoder(false);
    const blob = await encodeWithin({ width: 100, height: 100 }, 1_000_000, encode, (w, h) => ({ width: w, height: h }));
    expect(blob.type).toBe('image/jpeg');
  });

  it('lowers the quality, then the size, until it fits', async () => {
    const { encode, calls } = fakeEncoder();
    const blob = await encodeWithin({ width: 1000, height: 1000 }, 100_000, encode, (w, h) => ({ width: w, height: h }));
    expect(blob.size).toBeLessThanOrEqual(100_000);
    expect(calls.some((c) => c.w < 1000)).toBe(true);
    expect(new Set(calls.map((c) => c.quality)).size).toBeGreaterThan(1);
  });

  it('always answers within the bound', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 3000 }), fc.integer({ min: 1, max: 3000 }), fc.integer({ min: 2000, max: 2_000_000 }), async (w, h, max) => {
        const { encode } = fakeEncoder();
        const blob = await encodeWithin({ width: w, height: h }, max, encode, (sw, sh) => ({ width: sw, height: sh }));
        expect(blob.size).toBeLessThanOrEqual(max);
      }),
      { numRuns: 50 },
    );
  });

  it('gives up rather than shrinking forever when even one pixel is over the bound', async () => {
    const encode: Encoder = async (_s, type) => new Blob([new Uint8Array(500)], { type });
    await expect(encodeWithin({ width: 8, height: 8 }, 100, encode, (w, h) => ({ width: w, height: h }))).rejects.toThrow();
  });
});
