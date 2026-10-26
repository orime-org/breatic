// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Puts a tool step that did not finish where it happened in the reply
 * (inner#1620).
 *
 * The reply is still one markdown document, parsed once: a footnote and its
 * definition, or a reference link and its address, meet only inside one
 * parse, and a failure between them must not split it. So the place is held
 * by a paragraph of its own carrying a placeholder, and this swaps that
 * paragraph for an element the panel draws, the way `citationPlugin` swaps a
 * marker for a chip.
 */
import type { Element, Root } from 'hast';

/**
 * The character a placeholder is wrapped in: one from Unicode's private use
 * area, which no prose carries and which is taken out of the model's text
 * before a placeholder is written next to it.
 */
export const PLACEHOLDER_MARK = '';

/** A placeholder, as the whole of its paragraph. */
const PLACEHOLDER = new RegExp(`^${PLACEHOLDER_MARK}failure:(\\d+)${PLACEHOLDER_MARK}$`);

/**
 * The text that holds the place of one failure line.
 * @param index - Which line, counting from 0 in the order they were read.
 * @returns The placeholder.
 */
export function failurePlaceholder(index: number): string {
  return `${PLACEHOLDER_MARK}failure:${String(index)}${PLACEHOLDER_MARK}`;
}

/**
 * Swap every placeholder paragraph for the element that draws its line.
 * @returns A rehype transformer.
 */
export function toolFailurePlugin(): (tree: Root) => void {
  return (tree) => {
    tree.children = tree.children.map((node) => {
      if (node.type !== 'element' || node.tagName !== 'p' || node.children.length !== 1) return node;
      const only = node.children[0];
      if (only?.type !== 'text') return node;
      const match = PLACEHOLDER.exec(only.value.trim());
      if (match === null) return node;
      const line: Element = { type: 'element', tagName: 'tool-failure', properties: { index: match[1] }, children: [] };
      return line;
    });
  };
}
