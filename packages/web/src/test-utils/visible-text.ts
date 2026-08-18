// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Every string of text a region holds, in the order it holds them.
 *
 * Text nodes, not elements: a string written straight into a container next to
 * that container's elements is text the region is showing just as much as one
 * wrapped in a `<span>` of its own, and walking elements misses it entirely.
 * Whitespace-only nodes are dropped, so the gaps between tags do not count.
 *
 * Visibility is not judged. jsdom does no layout, so `display: none` and an
 * `sr-only` class both read as ordinary text here; a region whose contents are
 * hidden on purpose needs a different question asked of it.
 * @param region - The element to look inside.
 * @returns The strings it holds, trimmed.
 */
export function textIn(region: HTMLElement): string[] {
  const walk = region.ownerDocument.createTreeWalker(region, NodeFilter.SHOW_TEXT);
  const found: string[] = [];
  for (let node = walk.nextNode(); node !== null; node = walk.nextNode()) {
    const text = node.nodeValue?.trim() ?? '';
    if (text.length > 0) found.push(text);
  }
  return found;
}

/**
 * Whatever a region holds beyond the strings it is supposed to hold.
 *
 * For asserting that something is *not* on screen without naming how it would
 * have been written. Asking whether a particular test id is absent, or whether
 * any text looks like a number, both fail the same way: the first passes when
 * the thing comes back under another name, and the second cannot tell a count
 * of `(7)` from a conversation someone called `2026`. Saying what the region
 * is allowed to contain leaves an addition nowhere to go, whichever of the two
 * shapes it is written in -- its own element, or bare text beside one.
 * @param region - The element to look inside.
 * @param expected - The strings that belong there.
 * @returns Anything else it holds.
 */
export function unexpectedTextIn(region: HTMLElement, expected: readonly string[]): string[] {
  const allowed = new Set(expected);
  return textIn(region).filter((text) => !allowed.has(text));
}
