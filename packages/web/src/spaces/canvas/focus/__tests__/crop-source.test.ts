// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it, vi } from 'vitest';

import { intrinsicSize, originalSrc, whenDecoded } from '@web/spaces/canvas/focus/crop-source';

const STORED = 'https://resource-dev.breatic.cc/image/2026-09-30/1_18f58aed-b802-4243-a8ea-02d377de9679.png';

/**
 * An image element as an image node renders it.
 * @param src - Its address.
 * @param declared - The width and height attributes it carries, if any.
 * @param natural - The pixels it decoded.
 * @returns The element.
 */
function nodeImage(
  src: string,
  declared: { width: number; height: number } | null,
  natural: { width: number; height: number },
): HTMLImageElement {
  const img = document.createElement('img');
  img.setAttribute('src', src);
  if (declared !== null) {
    img.setAttribute('width', String(declared.width));
    img.setAttribute('height', String(declared.height));
  }
  Object.defineProperty(img, 'naturalWidth', { value: natural.width });
  Object.defineProperty(img, 'naturalHeight', { value: natural.height });
  return img;
}

// An image node shows a preview at most 576 wide and declares the original's
// size on the element (inner#1320); a crop is cut in the original's pixels.
describe('the crop source read as the original', () => {
  it('measures a preview as the original it stands for', () => {
    const img = nodeImage(`${STORED}.preview.webp`, { width: 4096, height: 2048 }, { width: 576, height: 288 });
    expect(intrinsicSize(img)).toEqual({ width: 4096, height: 2048 });
    expect(originalSrc(img)).toBe(STORED);
  });

  it('measures an original by its own pixels', () => {
    const img = nodeImage(STORED, null, { width: 800, height: 600 });
    expect(intrinsicSize(img)).toEqual({ width: 800, height: 600 });
    expect(originalSrc(img)).toBe(STORED);
  });
});

// Decoding ends when the browser has the bitmap, not after a count of frames;
// the export waits on the same `decode()` (`prepareCropSource`).
describe('whenDecoded', () => {
  /**
   * A picture of a given natural width whose decode settles as asked.
   * @param naturalWidth - Its decoded width, 0 while decoding.
   * @param decoded - Whether its decode succeeds.
   * @returns The picture.
   */
  const picture = (naturalWidth: number, decoded = true): HTMLImageElement => {
    const img = document.createElement('img');
    Object.defineProperty(img, 'naturalWidth', { value: naturalWidth });
    img.decode = (): Promise<void> => (decoded ? Promise.resolve() : Promise.reject(new Error('broken')));
    return img;
  };

  it('runs the step once a picture still decoding has decoded', async () => {
    const then = vi.fn();
    expect(whenDecoded(picture(0), then)).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(then).toHaveBeenCalledOnce();
  });

  it('waits on nothing for a picture already decoded, or no picture', () => {
    const then = vi.fn();
    expect(whenDecoded(picture(800), then)).toBe(false);
    expect(whenDecoded(null, then)).toBe(false);
    expect(then).not.toHaveBeenCalled();
  });

  it('gives up on a picture that cannot decode', async () => {
    const then = vi.fn();
    expect(whenDecoded(picture(0, false), then)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(then).not.toHaveBeenCalled();
  });
});
