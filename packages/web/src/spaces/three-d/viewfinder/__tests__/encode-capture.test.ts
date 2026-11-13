// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeCapturePng, flipRows } from '@web/spaces/three-d/viewfinder/encode-capture';

afterEach(() => { vi.unstubAllGlobals(); });

describe('turning read-back pixels into a PNG (#1411 design 4)', () => {
  it('flips WebGL bottom-up rows into top-down image rows', () => {
    const pixels = Uint8Array.from([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 6]);
    expect([...flipRows(pixels, 2, 3)]).toEqual([5, 5, 5, 5, 6, 6, 6, 6, 3, 3, 3, 3, 4, 4, 4, 4, 1, 1, 1, 1, 2, 2, 2, 2]);
  });

  it('draws the flipped pixels on an offscreen canvas of the capture size and encodes a PNG', async () => {
    const put = vi.fn();
    const convert = vi.fn(async () => new Blob(['png'], { type: 'image/png' }));
    const sizes: Array<[number, number]> = [];
    vi.stubGlobal('OffscreenCanvas', class {
      constructor(width: number, height: number) { sizes.push([width, height]); }
      getContext(): unknown { return { putImageData: put }; }
      convertToBlob = convert;
    });
    vi.stubGlobal('ImageData', class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} });
    const blob = await encodeCapturePng({ width: 1, height: 2, pixels: Uint8Array.from([1, 1, 1, 1, 2, 2, 2, 2]) });
    expect(sizes).toEqual([[1, 2]]);
    expect([...(put.mock.calls[0]?.[0] as { data: Uint8ClampedArray }).data]).toEqual([2, 2, 2, 2, 1, 1, 1, 1]);
    expect(convert).toHaveBeenCalledWith({ type: 'image/png' });
    expect(blob.type).toBe('image/png');
  });
});
