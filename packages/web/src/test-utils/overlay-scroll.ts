// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { expect } from 'vitest';

/**
 * Assert that a modal's content sits inside a scrollable overlay.
 *
 * `Dialog` and `AlertDialog` share one structure: the overlay covers the
 * screen and scrolls, a Scroller viewport inside it centers the content and
 * keeps a gutter, and the content itself is an ordinary in-flow box. Both
 * primitives are checked against this one function so neither can drift.
 *
 * The layout facts this structure buys — the bottom edge reachable, the box
 * centered, the bar drawn by the Scroller — are measured in Playwright; jsdom
 * has no layout engine, so what it can hold is the nesting and the classes.
 * @param content The element rendered by the primitive's `Content`.
 * @throws {Error} When the content is not nested the way the contract says.
 */
export function expectContentScrollsInsideOverlay(content: HTMLElement): void {
  const chain: HTMLElement[] = [];
  for (let node = content.parentElement; node; node = node.parentElement) {
    chain.push(node);
  }

  const viewport = chain.find((node) =>
    node.hasAttribute('data-radix-scroll-area-viewport'),
  );
  expect(viewport).toBeDefined();
  expect(chain.some((node) => node.classList.contains('inset-0'))).toBe(true);

  expect(viewport?.className).toContain('grid');
  expect(viewport?.className).toContain('place-items-center');
  expect(viewport?.className).toContain('min-h-full');
  // The gutter matches the padding the header and footer already use, and
  // stays under the 24px the x axis can afford — the viewport scrolls on one
  // axis only, so a wider gutter would push the box out of reach sideways.
  expect(viewport?.className).toContain('p-4');
}

/**
 * Assert that the content no longer centers itself the way it used to.
 *
 * Centering moved to the overlay's grid, so the content has to be in flow —
 * a `fixed` box would leave the scroller again and take the bug with it.
 * @param content The element rendered by the primitive's `Content`.
 * @throws {Error} When the content still positions or centers itself.
 */
export function expectContentIsInFlow(content: HTMLElement): void {
  expect(content.className).not.toContain('fixed');
  expect(content.className).not.toContain('translate-x-[-50%]');
  expect(content.className).not.toContain('translate-y-[-50%]');
  expect(content.className).toContain('relative');
  // Radix wraps the viewport's children in a div carrying an inline
  // `min-width: 100%` that index.css does not override, so that wrapper fills
  // the grid area and `place-items-center` centers nothing horizontally. The
  // auto margins are what actually center the box.
  expect(content.className).toContain('mx-auto');
}

/**
 * Assert that the overlay and the content animate for the same length.
 *
 * The content unmounts with the overlay around it now, so a shorter overlay
 * transition would cut the content's exit animation short.
 * @param overlay The element rendered by the primitive's `Overlay`.
 * @param content The element rendered by the primitive's `Content`.
 * @throws {Error} When the two transition lengths differ.
 */
export function expectExitAnimationsMatch(
  overlay: HTMLElement,
  content: HTMLElement,
): void {
  expect(overlay.className).toContain('duration-200');
  expect(content.className).toContain('duration-200');
}

/**
 * Find the rendered overlay — the one element that covers the whole screen.
 * @returns The overlay element.
 * @throws {Error} When no overlay is in the document.
 */
export function findOverlay(): HTMLElement {
  const overlay = Array.from(document.querySelectorAll('div')).find((node) =>
    node.classList.contains('inset-0'),
  );
  if (!overlay) {
    throw new Error('no overlay rendered');
  }
  return overlay;
}
