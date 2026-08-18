// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Every piece of text a region actually shows, in the order it shows them.
 *
 * Leaf elements only, so a wrapper is not counted again for the text of its
 * children, and blank ones are dropped. What comes back is what a reader would
 * be able to point at.
 * @param region - The element to look inside.
 * @returns The visible strings, trimmed.
 */
export function visibleTextIn(region: HTMLElement): string[] {
  return Array.from(region.querySelectorAll('*'))
    .filter((el) => el.children.length === 0)
    .map((el) => el.textContent?.trim() ?? '')
    .filter((text) => text.length > 0);
}

/**
 * Whatever a region shows beyond the strings it is supposed to show.
 *
 * For asserting that something is *not* on screen without naming how it would
 * have been written. Asking whether a particular test id is absent, or whether
 * any text looks like a number, both fail the same way: the first passes when
 * the thing comes back under another name, and the second cannot tell a count
 * of `(7)` from a conversation someone called `2026`. Saying what the region is
 * allowed to contain leaves nowhere for an addition to hide.
 * @param region - The element to look inside.
 * @param expected - The strings that belong there.
 * @returns Anything else it is showing.
 */
export function unexpectedTextIn(region: HTMLElement, expected: readonly string[]): string[] {
  const allowed = new Set(expected);
  return visibleTextIn(region).filter((text) => !allowed.has(text));
}
