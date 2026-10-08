// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The arithmetic the crop box inside a node rests on (inner#888 §7.4.1).
 */

import { describe, expect, it } from 'vitest';

import {
  fromFraction,
  handleScale,
  offsetWithin,
  toFraction,
} from '@web/spaces/canvas/crop/crop-geometry';

/**
 * An element whose layout offsets are stubbed, jsdom having no layout.
 * @param left - Its `offsetLeft`.
 * @param top - Its `offsetTop`.
 * @param parent - Its `offsetParent`.
 * @returns The element.
 */
function laidOut(left: number, top: number, parent: HTMLElement | null, border = 0): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'offsetLeft', { value: left });
  Object.defineProperty(el, 'offsetTop', { value: top });
  Object.defineProperty(el, 'offsetParent', { value: parent });
  Object.defineProperty(el, 'clientLeft', { value: border });
  Object.defineProperty(el, 'clientTop', { value: border });
  return el;
}

describe('offsetWithin', () => {
  it('adds every positioned layer between the element and the wrapper', () => {
    const wrapper = laidOut(0, 0, null);
    const shell = laidOut(0, 0, wrapper);
    const player = laidOut(5, 5, shell);
    const video = laidOut(0, 0, player);
    expect(offsetWithin(video, wrapper)).toEqual({ x: 5, y: 5 });
  });

  // An offset is measured from inside the offset parent's border, so every
  // border between the element and the wrapper is added; the wrapper's own is
  // not, the box being placed inside it as well.
  it('adds the borders of the layers in between, and not the wrapper own', () => {
    const wrapper = laidOut(0, 0, null, 2);
    const shell = laidOut(0, 0, wrapper, 1);
    const img = laidOut(4, 4, shell);
    expect(offsetWithin(img, wrapper)).toEqual({ x: 5, y: 5 });
  });

  it('counts the element sitting straight on the wrapper', () => {
    const wrapper = laidOut(0, 0, null);
    const img = laidOut(1, 1, wrapper);
    expect(offsetWithin(img, wrapper)).toEqual({ x: 1, y: 1 });
  });

  it('answers null when the wrapper is not on the chain', () => {
    const wrapper = laidOut(0, 0, null);
    const elsewhere = laidOut(3, 3, null);
    expect(offsetWithin(laidOut(1, 1, elsewhere), wrapper)).toBeNull();
  });
});

describe('fractions of the shown box', () => {
  const BOX = { width: 400, height: 300 };

  it('round-trips a rect in box pixels', () => {
    const rect = { x: 50, y: 30, width: 100, height: 90 };
    expect(toFraction(rect, BOX)).toEqual({ x: 0.125, y: 0.1, width: 0.25, height: 0.3 });
    expect(fromFraction(toFraction(rect, BOX), BOX)).toEqual(rect);
  });

  it('follows the box when it changes size', () => {
    const frac = { x: 0.125, y: 0.1, width: 0.25, height: 0.3 };
    expect(fromFraction(frac, { width: 400, height: 150 })).toEqual({ x: 50, y: 15, width: 100, height: 45 });
  });
});

describe('handleScale', () => {
  // The handles are what the reader drags, so they hold their screen size at
  // every zoom (user 2026-10-07); there is no floor as the node name has.
  it('cancels the zoom at every zoom', () => {
    for (const zoom of [0.1, 0.25, 0.5, 1, 2, 4]) {
      expect(handleScale(zoom) * zoom).toBeCloseTo(1, 10);
    }
  });

  it('answers 1 for a zoom that cannot be divided by', () => {
    expect(handleScale(0)).toBe(1);
  });
});
