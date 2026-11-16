// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The attributes a copied formula carries its LaTeX in (inner#1423). The chat
 * writes them on what it copies and the document body reads them back, so a
 * formula pasted from a reply arrives as a formula; anywhere else the copy
 * reads as its `$$` text.
 */

/** The attribute an inline formula's source travels in. */
export const MATH_SOURCE_ATTR = 'data-math';

/** The attribute a block formula's source travels in. */
export const MATH_BLOCK_SOURCE_ATTR = 'data-math-block';

/**
 * The element a formula's source travels in: the source in our attribute,
 * and as its words the `$$` text anything else reads.
 * @param source - The LaTeX.
 * @param block - Whether the formula stands on a line of its own.
 * @returns A `div` for a block formula, a `span` for an inline one.
 */
export function formulaSourceHolder(source: string, block: boolean): HTMLElement {
  const holder = document.createElement(block ? 'div' : 'span');
  holder.setAttribute(block ? MATH_BLOCK_SOURCE_ATTR : MATH_SOURCE_ATTR, source);
  holder.textContent = block ? `$$\n${source}\n$$` : `$$${source}$$`;
  return holder;
}
