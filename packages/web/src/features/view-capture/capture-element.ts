// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Options } from 'html-to-image/lib/types';

/**
 * The colour a transparent element is seen against: the first painted
 * background up its tree.
 * @param el - The element.
 * @returns A CSS colour, or undefined when nothing up the tree is painted.
 */
export function backgroundBehind(el: Element): string | undefined {
  for (let at: Element | null = el; at !== null; at = at.parentElement) {
    const colour = getComputedStyle(at).backgroundColor;
    if (colour !== '' && colour !== 'transparent' && colour !== 'rgba(0, 0, 0, 0)') return colour;
  }
  return undefined;
}

/**
 * Draw an element as the user sees it, its backdrop included (#1488 §19.1).
 * html-to-image loads only when a capture is asked for.
 * @param el - The element.
 * @param options - html-to-image options.
 * @returns The canvas.
 */
export async function captureElement(el: HTMLElement, options: Options = {}): Promise<HTMLCanvasElement> {
  const { toCanvas } = await import('html-to-image');
  return toCanvas(el, { pixelRatio: 1, backgroundColor: backgroundBehind(el), ...options });
}
