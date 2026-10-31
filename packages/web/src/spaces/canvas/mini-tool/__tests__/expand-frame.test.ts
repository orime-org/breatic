// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The expand frame's geometry (inner#1303 §6.3). A frame is held as shares of
 * the source: the source is the rectangle from 0,0 to 1,1, and the frame has
 * to contain it.
 */

import { describe, it, expect } from 'vitest';

import {
  UNIT_FRAME,
  expandDrop,
  expandLayout,
  frameForRatio,
  isExpanded,
  moveSource,
  ratioFits,
  resizeFrame,
  sourceTooLargeToExpand,
  type ExpandFrame,
} from '@web/spaces/canvas/mini-tool/expand-frame';

const LANDSCAPE = { width: 1600, height: 1000 };
const CAP = 12288;

/**
 * A frame's size in source pixels.
 * @param frame - The frame.
 * @param source - The source's pixels.
 * @param source.width - Its width.
 * @param source.height - Its height.
 * @returns Width and height.
 */
function pixels(frame: ExpandFrame, source: { width: number; height: number }): { width: number; height: number } {
  return { width: frame.width * source.width, height: frame.height * source.height };
}

// The panel hangs under the frame wherever the node is, drawn or not, so its
// offset comes from the draft and the node's size alone.
describe('expandDrop', () => {
  const view = { at: { x: 0, y: 20 }, box: { width: 400, height: 300 }, src: null };
  const still = { x: 0, y: 0 };

  it('is nothing while the frame ends inside the node', () => {
    expect(expandDrop({ frame: UNIT_FRAME, shift: still, view }, 340, 2)).toBe(0);
  });

  it('is how far the frame reaches below the node, in screen pixels', () => {
    const frame = { x: 0, y: 0, width: 1, height: 1.5 };
    expect(expandDrop({ frame, shift: still, view }, 340, 2)).toBeCloseTo(260, 9);
    expect(expandDrop({ frame, shift: { x: 0, y: 0.1 }, view }, 340, 2)).toBeCloseTo(320, 9);
  });

  it('is nothing until the node has shown the picture', () => {
    expect(expandDrop({ frame: { x: 0, y: 0, width: 1, height: 3 }, shift: still, view: null }, 340, 1)).toBe(0);
  });
});

describe('isExpanded', () => {
  it('reads the source-sized frame as not expanded, and any edge past it as expanded', () => {
    expect(isExpanded(UNIT_FRAME, LANDSCAPE)).toBe(false);
    expect(isExpanded({ x: -0.1, y: 0, width: 1.1, height: 1 }, LANDSCAPE)).toBe(true);
  });

  // The export pads by whole pixels; a frame past the source by under half a
  // pixel exports the source as it is, so it is not expanded (round 2, R12).
  it('reads a frame past the source by under half a pixel as not expanded', () => {
    const shot = { width: 1366, height: 768 };
    expect(isExpanded({ x: 0, y: -0.000244, width: 1, height: 1.000488 }, shot)).toBe(false);
    expect(isExpanded({ x: 0, y: -0.001, width: 1, height: 1.002 }, shot)).toBe(true);
  });
});

describe('frameForRatio', () => {
  it('wraps the source in the smallest frame of the ratio, centred on it', () => {
    const frame = frameForRatio('9:16', LANDSCAPE, UNIT_FRAME);
    const size = pixels(frame, LANDSCAPE);
    expect(size.width).toBeCloseTo(1600, 6);
    expect(size.width / size.height).toBeCloseTo(9 / 16, 6);
    expect(frame.x).toBeCloseTo(0, 6);
    expect(frame.y + frame.height / 2).toBeCloseTo(0.5, 6);
  });

  it('keeps the frame at the source for Free or the source’s own ratio while not expanded', () => {
    expect(frameForRatio('free', LANDSCAPE, UNIT_FRAME)).toEqual(UNIT_FRAME);
    expect(frameForRatio('16:9', { width: 1920, height: 1080 }, UNIT_FRAME)).toEqual(UNIT_FRAME);
    // 1366 by 768 is 16:9 to within half a pixel.
    expect(frameForRatio('16:9', { width: 1366, height: 768 }, UNIT_FRAME)).toEqual(UNIT_FRAME);
  });

  it('keeps an expanded frame as it is when Free is chosen', () => {
    const expanded = { x: -0.2, y: -0.1, width: 1.5, height: 1.3 };
    expect(frameForRatio('free', LANDSCAPE, expanded)).toBe(expanded);
  });
});

describe('ratioFits', () => {
  it('refuses a ratio whose wrapping frame is longer than the cap', () => {
    expect(ratioFits('9:16', { width: 8000, height: 6000 }, CAP)).toBe(false);
    expect(ratioFits('1:1', { width: 8000, height: 6000 }, CAP)).toBe(true);
  });
});

describe('resizeFrame', () => {
  it('drags one edge outward and leaves the others where they were, while free', () => {
    const frame = resizeFrame(UNIT_FRAME, 'e', { x: 1.4, y: 0.5 }, 'free', LANDSCAPE, CAP);
    expect(frame).toEqual({ x: 0, y: 0, width: 1.4, height: 1 });
  });

  it('never lets an edge inside the source', () => {
    expect(resizeFrame(UNIT_FRAME, 'w', { x: 0.3, y: 0.5 }, 'free', LANDSCAPE, CAP)).toEqual(UNIT_FRAME);
  });

  it('keeps the opposite edge put and the ratio when locked', () => {
    const start = frameForRatio('1:1', LANDSCAPE, UNIT_FRAME);
    const frame = resizeFrame(start, 'e', { x: 1.5, y: 0.5 }, '1:1', LANDSCAPE, CAP);
    expect(frame.x).toBeCloseTo(start.x, 6);
    const size = pixels(frame, LANDSCAPE);
    expect(size.width / size.height).toBeCloseTo(1, 6);
    expect(frame.y + frame.height / 2).toBeCloseTo(0.5, 6);
  });

  it('keeps a locked frame centred on its own middle across the drag, where the picture was moved in it', () => {
    // The picture moved to the frame's top edge: the frame's top is the picture's.
    const moved = { ...frameForRatio('9:16', LANDSCAPE, UNIT_FRAME), y: 0 };
    const middle = moved.y + moved.height / 2;
    const frame = resizeFrame(moved, 'e', { x: 1.2, y: 0.5 }, '9:16', LANDSCAPE, CAP);
    expect(frame.height).toBeGreaterThan(moved.height);
    expect(frame.y + frame.height / 2).toBeCloseTo(middle, 6);
    expect(frame.y).toBeLessThanOrEqual(0);
    expect(frame.y + frame.height).toBeGreaterThanOrEqual(1);
  });

  it('shifts a locked frame only as far as it takes to keep wrapping the picture', () => {
    // Grown, then the picture moved to the frame's top: shrinking about the
    // frame's middle would leave the picture's top outside, so the frame stops at it.
    const grown = resizeFrame(frameForRatio('9:16', LANDSCAPE, UNIT_FRAME), 'e', { x: 1.5, y: 0.5 }, '9:16', LANDSCAPE, CAP);
    const atTop = moveSource(grown, { x: 0, y: -10 });
    expect(atTop.y).toBe(0);
    const shrunk = resizeFrame(atTop, 'e', { x: 1.1, y: 0.5 }, '9:16', LANDSCAPE, CAP);
    expect(shrunk.height).toBeLessThan(atTop.height);
    expect(shrunk.y).toBe(0);
    expect(shrunk.y + shrunk.height).toBeGreaterThanOrEqual(1);
  });

  // A source past the cap cannot be expanded; its frame stays wrapping it
  // whatever the handles do.
  it.each([
    ['e', { x: 1.5, y: 0.5 }],
    ['w', { x: -0.5, y: 0.5 }],
  ] as const)('leaves the frame of a source past the cap where it is on a free %s drag', (handle, pointer) => {
    const panorama = { width: 13000, height: 2000 };
    expect(resizeFrame(UNIT_FRAME, handle, pointer, 'free', panorama, CAP)).toEqual(UNIT_FRAME);
  });

  it('can drag a locked frame back down to the source when the ratio is the source’s own', () => {
    const source = { width: 1600, height: 900 };
    const grown = resizeFrame(UNIT_FRAME, 'e', { x: 1.5, y: 0.5 }, '16:9', source, CAP);
    expect(isExpanded(grown, source)).toBe(true);
    expect(resizeFrame(grown, 'e', { x: 0.2, y: 0.5 }, '16:9', source, CAP)).toEqual(UNIT_FRAME);
  });

  it('stops the long side at the cap', () => {
    const source = { width: 10000, height: 5000 };
    const frame = resizeFrame(UNIT_FRAME, 'e', { x: 3, y: 0.5 }, 'free', source, CAP);
    expect(pixels(frame, source).width).toBeCloseTo(CAP, 6);
  });

  it('still grows a wide picture whose long side is already at the cap, across its short side', () => {
    const source = { width: CAP, height: 6000 };
    const frame = resizeFrame(UNIT_FRAME, 's', { x: 0.5, y: 1.5 }, 'free', source, CAP);
    expect(pixels(frame, source).height).toBeCloseTo(9000, 6);
    expect(frame.width).toBe(1);
  });
});

describe('moveSource', () => {
  it('moves the source inside the frame and keeps the frame’s size', () => {
    const frame = { x: -0.5, y: 0, width: 2, height: 1 };
    const moved = moveSource(frame, { x: 0.2, y: 0 });
    expect(moved).toEqual({ x: -0.7, y: 0, width: 2, height: 1 });
  });

  it('stops the source at the frame’s edge', () => {
    const frame = { x: -0.5, y: -0.25, width: 2, height: 1.5 };
    expect(moveSource(frame, { x: 3, y: -3 })).toEqual({ x: -1, y: 0, width: 2, height: 1.5 });
  });
});

describe('sourceTooLargeToExpand', () => {
  it('refuses a source longer than the cap, or one at the cap both ways', () => {
    expect(sourceTooLargeToExpand({ width: CAP + 1, height: 100 }, CAP)).toBe(true);
    expect(sourceTooLargeToExpand({ width: CAP, height: CAP }, CAP)).toBe(true);
  });

  it('lets a source at the cap one way grow the other way', () => {
    expect(sourceTooLargeToExpand({ width: CAP, height: 6000 }, CAP)).toBe(false);
  });
});

describe('expandLayout', () => {
  it('sizes the canvas to the frame in source pixels and puts the source where the frame leaves it', () => {
    expect(expandLayout({ x: -0.25, y: -0.1, width: 1.5, height: 1.3 }, { width: 1600, height: 1000 })).toEqual({
      width: 2400,
      height: 1300,
      sourceX: 400,
      sourceY: 100,
    });
  });

  it('rounds to whole pixels and never cuts into the source', () => {
    const layout = expandLayout({ x: -0.3333, y: 0, width: 1.6667, height: 1 }, { width: 999, height: 500 });
    expect(Number.isInteger(layout.width)).toBe(true);
    expect(layout.sourceX + 999).toBeLessThanOrEqual(layout.width);
    expect(layout.height).toBe(500);
  });
});
