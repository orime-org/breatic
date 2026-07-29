// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Where the crop box lives and how big it starts.
 *
 * Both answers are about the IMAGE's drawn area, never the container's. An
 * image whose aspect ratio differs from the frame's leaves letterbox margins,
 * and a selection allowed onto those margins crops in a band of empty space.
 */

import { describe, it, expect } from 'vitest';

import {
  imageBoxWithin,
  initialSquareCrop,
} from '@web/pages/studio/container/dialogs/avatar-crop';

/**
 * Build the rect shape the measurement reads.
 * @param left - Left offset in viewport px.
 * @param top - Top offset in viewport px.
 * @param width - Width in px.
 * @param height - Height in px.
 * @returns The rect.
 */
function rect(
  left: number,
  top: number,
  width: number,
  height: number,
): { left: number; top: number; width: number; height: number } {
  return { left, top, width, height };
}

describe('imageBoxWithin', () => {
  it('reports the drawn area relative to the frame, not the frame itself', () => {
    // A 400×300 frame showing a wide image: 400×200 drawn, 50px of letterbox
    // above and below.
    const box = imageBoxWithin(rect(100, 100, 400, 300), rect(100, 150, 400, 200));
    expect(box).toEqual({ x: 0, y: 50, width: 400, height: 200 });
  });

  it('reports pillarbox margins the same way', () => {
    const box = imageBoxWithin(rect(0, 0, 400, 300), rect(50, 0, 300, 300));
    expect(box).toEqual({ x: 50, y: 0, width: 300, height: 300 });
  });

  it('is a zero offset when the image fills the frame exactly', () => {
    const box = imageBoxWithin(rect(20, 40, 200, 200), rect(20, 40, 200, 200));
    expect(box).toEqual({ x: 0, y: 0, width: 200, height: 200 });
  });

  it('returns null while the dialog is still hidden', () => {
    // A `display:none` dialog measures 0×0. Seeding a crop from that produces
    // a 0×0 selection that never recovers once the dialog becomes visible,
    // so there is no box to report yet.
    expect(imageBoxWithin(rect(0, 0, 0, 0), rect(0, 0, 0, 0))).toBeNull();
  });

  it('returns null when the image has laid out but not yet decoded', () => {
    expect(imageBoxWithin(rect(0, 0, 400, 300), rect(0, 0, 0, 0))).toBeNull();
  });
});

describe('initialSquareCrop', () => {
  it('is the largest centred square inside a landscape image', () => {
    expect(initialSquareCrop({ width: 400, height: 200 })).toEqual({
      x: 100,
      y: 0,
      width: 200,
      height: 200,
    });
  });

  it('is the largest centred square inside a portrait image', () => {
    expect(initialSquareCrop({ width: 200, height: 400 })).toEqual({
      x: 0,
      y: 100,
      width: 200,
      height: 200,
    });
  });

  it('fills a square image completely', () => {
    expect(initialSquareCrop({ width: 300, height: 300 })).toEqual({
      x: 0,
      y: 0,
      width: 300,
      height: 300,
    });
  });

  it('is bounded by the image, not by the frame around it', () => {
    // The regression this guards: seeding from the 400×300 FRAME would give a
    // 300×300 square, 100px taller than the 400×200 image actually drawn —
    // so the crop would include letterbox.
    const box = imageBoxWithin(rect(0, 0, 400, 300), rect(0, 50, 400, 200))!;
    const crop = initialSquareCrop(box);
    expect(crop.height).toBe(200);
    expect(crop.y + crop.height).toBeLessThanOrEqual(box.height);
    expect(crop.x + crop.width).toBeLessThanOrEqual(box.width);
  });
});
