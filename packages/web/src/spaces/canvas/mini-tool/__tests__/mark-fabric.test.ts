// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Markup objects as Fabric draws them, and read back after the reader moves or
 * resizes one (inner#1303 §6.2).
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { Point, util } from 'fabric';

import { fromFabric, loadMarkFonts, markBackground, markStrokePx, toFabric } from '@web/spaces/canvas/mini-tool/mark-fabric';
import type { MarkObject } from '@web/stores/mark-draft';

const BOX = { width: 400, height: 300 };

const OBJECTS: MarkObject[] = [
  { id: 'r', kind: 'rect', color: '#FF3B30', size: 5, x: 0.1, y: 0.2, w: 0.3, h: 0.25 },
  { id: 'e', kind: 'ellipse', color: '#34C759', size: 8, x: 0.4, y: 0.1, w: 0.2, h: 0.3 },
  { id: 'l', kind: 'line', color: '#0A84FF', size: 3, x1: 0.1, y1: 0.9, x2: 0.7, y2: 0.6 },
  { id: 'a', kind: 'arrow', color: '#FFCC00', size: 4, x1: 0.2, y1: 0.2, x2: 0.8, y2: 0.5 },
  { id: 'p', kind: 'pen', color: '#000000', size: 2, points: [[0.1, 0.1], [0.2, 0.15], [0.3, 0.1]] },
  { id: 't', kind: 'text', color: '#FFFFFF', size: 6, x: 0.5, y: 0.5, text: 'eye wider' },
];

/**
 * Every number in an object, rounded, so a round trip compares without float noise.
 * @param object - The object.
 * @returns The same object with rounded numbers.
 */
function rounded(object: MarkObject): unknown {
  return JSON.parse(JSON.stringify(object), (_key, value: unknown) =>
    typeof value === 'number' ? Math.round(value * 1e6) / 1e6 : value,
  );
}

describe('toFabric and fromFabric', () => {
  it.each(OBJECTS.map((object) => [object.kind, object] as const))('round-trips a %s', (_kind, object) => {
    expect(rounded(fromFabric(toFabric(object, BOX), BOX))).toEqual(rounded(object));
  });

  // The same smoothing the pencil drew the stroke with, so it does not change shape when committed.
  it('draws a pen stroke through Fabric’s pencil smoothing of its points', () => {
    const pen = OBJECTS[4]!;
    if (pen.kind !== 'pen') throw new Error('not a pen');
    const points = pen.points.map(([x, y]) => new Point(x * BOX.width, y * BOX.height));
    const expected = util.getSmoothPathFromPoints(points, markStrokePx(pen.size, BOX) / 1000);
    expect((toFabric(pen, BOX) as unknown as { path: unknown }).path).toEqual(expected);
  });

  it('reads a moved rectangle back at its new place', () => {
    const shape = toFabric(OBJECTS[0]!, BOX);
    shape.set({ left: (shape.left ?? 0) + 40 });
    expect(fromFabric(shape, BOX)).toMatchObject({ x: 0.2 });
  });

  it('folds a stretch into the rectangle’s size and keeps its stroke', () => {
    const shape = toFabric(OBJECTS[0]!, BOX);
    shape.set({ scaleX: 2 });
    expect(fromFabric(shape, BOX)).toMatchObject({ w: 0.6, h: 0.25, size: 5 });
    expect(shape.strokeUniform).toBe(true);
  });

  it('moves both ends of a line', () => {
    const shape = toFabric(OBJECTS[2]!, BOX);
    shape.set({ left: (shape.left ?? 0) + 40, top: (shape.top ?? 0) - 30 });
    expect(rounded(fromFabric(shape, BOX))).toMatchObject({ x1: 0.2, y1: 0.8, x2: 0.8, y2: 0.5 });
  });

  it('folds a text’s scale into its size', () => {
    const text = toFabric(OBJECTS[5]!, BOX);
    text.set({ scaleX: 10, scaleY: 10 });
    expect(fromFabric(text, BOX)).toMatchObject({ size: 60 });
  });

  it('keeps only a text’s four corners, so it scales evenly', () => {
    const text = toFabric(OBJECTS[5]!, BOX);
    for (const side of ['ml', 'mr', 'mt', 'mb']) expect(text.isControlVisible(side)).toBe(false);
    for (const corner of ['tl', 'tr', 'bl', 'br']) expect(text.isControlVisible(corner)).toBe(true);
  });


  it('draws an arrowhead in proportion to the picture, so the node and the export match', () => {
    const arrow = { ...OBJECTS[3]!, size: 1 } as MarkObject;
    const small = toFabric(arrow, BOX);
    const large = toFabric(arrow, { width: 4000, height: 3000 });
    expect((large.width ?? 0) / (small.width ?? 1)).toBeCloseTo(10, 5);
    expect((large.height ?? 0) / (small.height ?? 1)).toBeCloseTo(10, 5);
  });

  it('turns off rotation and skew', () => {
    const shape = toFabric(OBJECTS[0]!, BOX);
    expect(shape.lockSkewingX && shape.lockSkewingY && shape.lockScalingFlip).toBe(true);
    expect(shape.isControlVisible('mtr')).toBe(false);
  });
});

describe('markBackground', () => {
  it('lays the picture from the top-left corner, where the objects are measured from', () => {
    const el = document.createElement('img');
    const picture = markBackground(el);
    expect([picture.left, picture.top, picture.originX, picture.originY]).toEqual([0, 0, 'left', 'top']);
  });
});

describe('markStrokePx', () => {
  it('draws a size as a share of the shorter side, so preview and export match', () => {
    expect(markStrokePx(8, { width: 400, height: 300 }) * (3000 / 300)).toBeCloseTo(markStrokePx(8, { width: 4000, height: 3000 }), 6);
  });
});

// The product's tokens, as the page's root holds them.
const TOKENS = {
  '--color-background': 'rgb(240, 240, 240)',
  '--color-foreground': 'rgb(30, 30, 30)',
  '--color-active-border': 'rgb(95, 95, 95)',
  '--font-sans': 'Inter, "Noto Sans SC", sans-serif',
};

describe('the markup’s look on the page', () => {
  beforeEach(() => {
    for (const [name, value] of Object.entries(TOKENS)) document.documentElement.style.setProperty(name, value);
  });
  afterEach(() => {
    for (const name of Object.keys(TOKENS)) document.documentElement.style.removeProperty(name);
  });

  // The crop and expand frames draw an 8px dot filled with the background and
  // ringed with the foreground; a markup object resizes freely, so its
  // handles are round as theirs are at a free ratio.
  it.each(OBJECTS.map((object) => [object.kind, object] as const))('gives a %s the product’s handles', (_kind, object) => {
    const shape = toFabric(object, BOX);
    expect(shape).toMatchObject({
      cornerStyle: 'circle',
      cornerSize: 8,
      transparentCorners: false,
      cornerColor: TOKENS['--color-background'],
      cornerStrokeColor: TOKENS['--color-foreground'],
      borderColor: TOKENS['--color-active-border'],
    });
  });

  it('writes a text in the product’s sans', () => {
    const text = toFabric(OBJECTS[5]!, BOX) as unknown as { fontFamily: string; fontWeight: number | string };
    expect(text.fontFamily).toBe(TOKENS['--font-sans']);
    expect(Number(text.fontWeight)).toBe(500);
  });

  // A face the page has not loaded is drawn and measured in another one.
  it('loads the face of every text before it is drawn', async () => {
    const load = vi.fn(() => Promise.resolve([]));
    vi.stubGlobal('document', Object.assign(Object.create(document), { fonts: { load }, documentElement: document.documentElement }));
    try {
      await loadMarkFonts(OBJECTS, BOX);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(expect.stringContaining(TOKENS['--font-sans']), 'eye wider');
  });
});
