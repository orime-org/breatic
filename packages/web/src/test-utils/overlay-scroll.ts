// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { expect } from 'vitest';

/**
 * Find the overlay a modal's content is rendered inside.
 *
 * Radix stamps `data-state` on the trigger, the overlay and the content and on
 * nothing in between, so the nearest one above the content is the overlay.
 * @param content The element rendered by the primitive's `Content`.
 * @returns The overlay element.
 * @throws {Error} When the content is not inside an overlay.
 */
function overlayOf(content: HTMLElement): HTMLElement {
  const overlay = content.parentElement?.closest<HTMLElement>('[data-state]');
  if (!overlay) throw new Error('the content is not inside an overlay');
  return overlay;
}

/**
 * Assert that a modal's content sits inside a scrollable overlay.
 *
 * `Dialog` and `AlertDialog` share one structure: the overlay covers the
 * screen and scrolls, a Scroller viewport inside it centres the content and
 * keeps a gutter, and the content itself is an ordinary in-flow box. Both
 * primitives are checked against this one function so neither can drift.
 *
 * The order is the load-bearing part — a scroller wrapped around the overlay
 * instead of inside it puts the content back outside the scroll flow, which
 * is the bug — so the viewport is required to be between the two.
 *
 * The layout facts this structure buys — the bottom edge reachable, the box
 * centred, the bar drawn by the Scroller — are measured in Playwright; jsdom
 * has no layout engine, so what it can hold is the nesting and the classes.
 * @param content The element rendered by the primitive's `Content`.
 * @throws {Error} When the content is not nested the way the contract says.
 */
export function expectContentScrollsInsideOverlay(content: HTMLElement): void {
  const overlay = overlayOf(content);
  const viewport = content.parentElement?.closest<HTMLElement>(
    '[data-radix-scroll-area-viewport]',
  );
  expect(viewport).toBeDefined();
  expect(overlay.contains(viewport!)).toBe(true);

  expect(viewport!.classList.contains('grid')).toBe(true);
  expect(viewport!.classList.contains('place-items-center')).toBe(true);
  expect(viewport!.classList.contains('p-4')).toBe(true);
}

/**
 * Assert that the content no longer centres itself the way it used to.
 *
 * Centring moved to the overlay's grid, so the content has to be in flow —
 * a `fixed` box would leave the scroller again and take the bug with it.
 * @param content The element rendered by the primitive's `Content`.
 * @throws {Error} When the content still positions or centres itself.
 */
export function expectContentIsInFlow(content: HTMLElement): void {
  for (const own of ['fixed', 'translate-x-[-50%]', 'translate-y-[-50%]']) {
    expect(content.classList.contains(own)).toBe(false);
  }
  expect(content.classList.contains('relative')).toBe(true);
  expect(content.classList.contains('mx-auto')).toBe(true);
}

/**
 * Assert that the overlay and the content animate for the same length.
 *
 * The content unmounts with the overlay around it now, so a shorter overlay
 * transition would cut the content's exit animation short. The relation is
 * what matters, so the length is read off the content rather than named here.
 * @param content The element rendered by the primitive's `Content`.
 * @throws {Error} When the two transition lengths differ.
 */
export function expectExitAnimationsMatch(content: HTMLElement): void {
  const length = /(?:^|\s)(duration-\d+)(?:\s|$)/.exec(content.className)?.[1];
  expect(length).toBeDefined();
  expect(overlayOf(content).classList.contains(length!)).toBe(true);
}
