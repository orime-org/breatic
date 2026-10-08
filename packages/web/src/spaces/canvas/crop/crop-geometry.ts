// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The arithmetic of the crop box drawn inside a node (inner#888 §7.4.1). The
 * box lives in the node's own layout pixels, which a pan or zoom never
 * changes; only the handles answer the zoom, to stay draggable.
 */

import type { CropRect } from '@web/lib/crop-math';

/** A size in layout pixels. */
export interface BoxSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Where an element sits inside one of its ancestors, in layout pixels.
 * `offsetLeft` and `offsetTop` are measured from the nearest positioned
 * ancestor, and between a node's media and the node's outer wrapper there are
 * several (the card, the media player), so the chain is walked up to it.
 * @param el - The element.
 * @param ancestor - The positioned ancestor to measure from.
 * @returns The offset, or null when the ancestor is not on the chain.
 */
export function offsetWithin(el: HTMLElement, ancestor: HTMLElement): { x: number; y: number } | null {
  let x = 0;
  let y = 0;
  let at: HTMLElement | null = el;
  while (at !== null && at !== ancestor) {
    x += at.offsetLeft;
    y += at.offsetTop;
    const parent: Element | null = at.offsetParent;
    at = parent instanceof HTMLElement ? parent : null;
    // An offset starts inside its parent's border; the wrapper's own border
    // is left out because the crop box is placed inside it too.
    if (at !== null && at !== ancestor) {
      x += at.clientLeft;
      y += at.clientTop;
    }
  }
  return at === ancestor ? { x, y } : null;
}

/**
 * A rect in box pixels as fractions of the box.
 * @param rect - The rect in box pixels.
 * @param box - The box.
 * @returns The rect as fractions (0 to 1).
 */
export function toFraction(rect: CropRect, box: BoxSize): CropRect {
  return {
    x: rect.x / box.width,
    y: rect.y / box.height,
    width: rect.width / box.width,
    height: rect.height / box.height,
  };
}

/**
 * Fractions of a box as a rect in its pixels.
 * @param frac - The rect as fractions.
 * @param box - The box.
 * @returns The rect in box pixels.
 */
export function fromFraction(frac: CropRect, box: BoxSize): CropRect {
  return {
    x: frac.x * box.width,
    y: frac.y * box.height,
    width: frac.width * box.width,
    height: frac.height * box.height,
  };
}

/**
 * The factor that keeps a handle at its screen size inside the zoomed node
 * layer. A handle is a control the reader drags, so it holds its size at
 * every zoom (user 2026-10-07), unlike the node's name, which stops growing
 * below half zoom.
 * @param zoom - The canvas zoom.
 * @returns The counter-scale.
 */
export function handleScale(zoom: number): number {
  return zoom > 0 ? 1 / zoom : 1;
}
