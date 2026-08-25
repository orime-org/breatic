// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
  rescaleCrop,
} from '@web/pages/studio/container/dialogs/avatar-crop';

/**
 * Build the image's offset box, as the layout properties report it.
 * @param left - Offset from the frame's left edge.
 * @param top - Offset from the frame's top edge.
 * @param width - Layout width in px.
 * @param height - Layout height in px.
 * @returns The offset box.
 */
function offset(
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
    const box = imageBoxWithin(
      { width: 400, height: 300 },
      offset(0, 50, 400, 200),
    );
    expect(box).toEqual({ x: 0, y: 50, width: 400, height: 200 });
  });

  it('reports pillarbox margins the same way', () => {
    const box = imageBoxWithin(
      { width: 400, height: 300 },
      offset(50, 0, 300, 300),
    );
    expect(box).toEqual({ x: 50, y: 0, width: 300, height: 300 });
  });

  it('is a zero offset when the image fills the frame exactly', () => {
    const box = imageBoxWithin(
      { width: 200, height: 200 },
      offset(0, 0, 200, 200),
    );
    expect(box).toEqual({ x: 0, y: 0, width: 200, height: 200 });
  });

  it('returns null while the dialog is still hidden', () => {
    // A `display:none` dialog measures 0×0. Seeding a crop from that produces
    // a 0×0 selection that never recovers once the dialog becomes visible,
    // so there is no box to report yet.
    expect(imageBoxWithin({ width: 0, height: 0 }, offset(0, 0, 0, 0))).toBeNull();
  });

  it('returns null when the image has laid out but not yet decoded', () => {
    expect(
      imageBoxWithin({ width: 400, height: 300 }, offset(0, 0, 0, 0)),
    ).toBeNull();
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

  it('leaves nothing outside the image on either axis', () => {
    // Caught in a browser: the selection sat 1px above the image's top edge
    // and was ~5% too small, because it had been seeded while the dialog was
    // still animating open and never re-scaled once the image settled.
    for (const box of [
      { width: 486, height: 243 },
      { width: 243, height: 486 },
      { width: 300, height: 300 },
    ]) {
      const crop = initialSquareCrop(box);
      expect(crop.x).toBeGreaterThanOrEqual(0);
      expect(crop.y).toBeGreaterThanOrEqual(0);
      expect(crop.x + crop.width).toBeLessThanOrEqual(box.width);
      expect(crop.y + crop.height).toBeLessThanOrEqual(box.height);
      expect(crop.width).toBe(Math.min(box.width, box.height));
    }
  });

  it('is bounded by the image, not by the frame around it', () => {
    // The regression this guards: seeding from the 400×300 FRAME would give a
    // 300×300 square, 100px taller than the 400×200 image actually drawn —
    // so the crop would include letterbox.
    const box = imageBoxWithin(
      { width: 400, height: 300 },
      offset(0, 50, 400, 200),
    )!;
    const crop = initialSquareCrop(box);
    expect(crop.height).toBe(200);
    expect(crop.y + crop.height).toBeLessThanOrEqual(box.height);
    expect(crop.x + crop.width).toBeLessThanOrEqual(box.width);
  });
});

describe('rescaleCrop', () => {
  // The dialog animates open, so the image is measured at least twice: once
  // mid-animation and once settled. Keeping the first selection unchanged
  // leaves it sized for a box that no longer exists — in a browser that came
  // out ~5% small and 1px above the image's top edge. The same applies when
  // the window is resized mid-crop.
  it('grows the selection with the image', () => {
    const before = { x: 116, y: 0, width: 232, height: 232 };
    const after = rescaleCrop(
      before,
      { width: 464, height: 232 },
      { width: 486, height: 243 },
    );
    expect(after.width).toBeCloseTo(243, 0);
    expect(after.height).toBeCloseTo(243, 0);
  });

  it('shrinks it too', () => {
    const after = rescaleCrop(
      { x: 100, y: 0, width: 200, height: 200 },
      { width: 400, height: 200 },
      { width: 200, height: 100 },
    );
    expect(after.width).toBeCloseTo(100, 0);
    expect(after.x).toBeCloseTo(50, 0);
  });

  it('keeps the result square even if the box aspect drifted', () => {
    const after = rescaleCrop(
      { x: 0, y: 0, width: 100, height: 100 },
      { width: 200, height: 200 },
      { width: 300, height: 250 },
    );
    expect(after.width).toBe(after.height);
  });

  it('never leaves the selection outside the new box', () => {
    const after = rescaleCrop(
      { x: 190, y: 0, width: 200, height: 200 },
      { width: 400, height: 200 },
      { width: 200, height: 400 },
    );
    expect(after.x).toBeGreaterThanOrEqual(0);
    expect(after.y).toBeGreaterThanOrEqual(0);
    expect(after.x + after.width).toBeLessThanOrEqual(200);
    expect(after.y + after.height).toBeLessThanOrEqual(400);
  });

  it('returns the selection untouched when the box did not change', () => {
    const rect = { x: 10, y: 20, width: 100, height: 100 };
    expect(
      rescaleCrop(rect, { width: 300, height: 300 }, { width: 300, height: 300 }),
    ).toBe(rect);
  });

  it('leaves it alone rather than dividing by zero on a degenerate old box', () => {
    const rect = { x: 10, y: 20, width: 100, height: 100 };
    expect(
      rescaleCrop(rect, { width: 0, height: 0 }, { width: 300, height: 300 }),
    ).toBe(rect);
  });
});
