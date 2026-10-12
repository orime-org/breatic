// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How big each node already on the canvas is, for a proposal looking for a
 * clear spot (inner#1443). The canvas mounts only what is in view, so a node
 * off screen may never have been measured, or kept a size from before its
 * content changed; the document decides wherever it can.
 */

import { describe, it, expect } from 'vitest';

import type { NodePlacement } from '@web/data/yjs/canvas-space';
import { EMPTY_NODE_SIZE } from '@web/spaces/canvas/group-geometry';
import {
  mediaFootprintHeight,
  occupiedRects,
  textFootprintHeight,
} from '@web/spaces/canvas/lib/place-flow';

/**
 * One node as the document reports it.
 * @param fields - What differs from an empty image node at the origin.
 * @returns The placement.
 */
const at = (fields: Partial<NodePlacement> & Pick<NodePlacement, 'id'>): NodePlacement => ({
  type: 'image',
  x: 0,
  y: 0,
  ...fields,
});

const noMeasure = (): undefined => undefined;

describe('occupiedRects', () => {
  it('sizes a group by its own width and height, whatever was measured', () => {
    const rects = occupiedRects([at({ id: 'g', type: 'group', width: 600, height: 400 })], () => ({
      width: 10,
      height: 10,
    }));
    expect(rects).toEqual([{ x: 0, y: 0, width: 600, height: 400 }]);
  });

  it('leaves notes out', () => {
    expect(occupiedRects([at({ id: 'n', type: 'annotation' })], noMeasure)).toEqual([]);
  });

  it('sizes a picture by its pixels even when the measured size is stale', () => {
    const rects = occupiedRects(
      [at({ id: 'i', type: 'image', mediaWidth: 1080, mediaHeight: 1920 })],
      () => ({ width: EMPTY_NODE_SIZE.width, height: EMPTY_NODE_SIZE.height }),
    );
    expect(rects[0]).toEqual({
      x: 0,
      y: 0,
      width: EMPTY_NODE_SIZE.width,
      height: mediaFootprintHeight(1080, 1920),
    });
  });

  it('sizes a video that has never been measured by its pixels', () => {
    const rects = occupiedRects([at({ id: 'v', type: 'video', mediaWidth: 1920, mediaHeight: 1080 })], noMeasure);
    expect(rects[0]?.height).toBe(mediaFootprintHeight(1920, 1080));
  });

  it('sizes text by what was measured when it draws taller than its words', () => {
    const rects = occupiedRects([at({ id: 't', type: 'text', bodyText: 'x' })], () => ({ width: 288, height: 333 }));
    expect(rects[0]?.height).toBe(333);
  });

  it('sizes text by its words when they grew past what was last measured', () => {
    const words = 'word '.repeat(200);
    const rects = occupiedRects([at({ id: 't', type: 'text', bodyText: words })], () => ({
      width: EMPTY_NODE_SIZE.width,
      height: EMPTY_NODE_SIZE.height,
    }));
    expect(rects[0]?.height).toBe(textFootprintHeight(words));
  });

  it('estimates text that has never been measured from its words', () => {
    const words = 'word '.repeat(200);
    const rects = occupiedRects([at({ id: 't', type: 'text', bodyText: words })], noMeasure);
    expect(rects[0]?.height).toBe(textFootprintHeight(words));
  });

  it('gives any other node that has never been measured the standard footprint', () => {
    const rects = occupiedRects([at({ id: 'a', type: 'audio', x: 5, y: 7 })], noMeasure);
    expect(rects).toEqual([{ x: 5, y: 7, ...EMPTY_NODE_SIZE }]);
  });

  it('sizes any other node by what was measured', () => {
    const rects = occupiedRects([at({ id: 'a', type: 'audio' })], () => ({ width: 300, height: 120 }));
    expect(rects[0]).toMatchObject({ width: 300, height: 120 });
  });
});
