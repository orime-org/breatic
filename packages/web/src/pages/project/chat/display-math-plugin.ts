// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Gives a display formula an element the renderer can hang a scroller on.
 *
 * KaTeX writes `white-space: nowrap` on a display formula and offers no
 * overflow of its own, and the list around the reply scrolls vertically only,
 * so a formula wider than the chat column is cut off with nothing to drag.
 *
 * There is nothing to catch it by until this runs: `rehype-katex` ends on
 * `parent.children.splice(index, 1, ...result)` (lib/index.js), which replaces
 * the `div.math.math-display` remark-math produced, so what the renderer is
 * handed is a bare `span.katex-display`. This step must therefore come after
 * it.
 */
import type { Element, Root } from 'hast';

/**
 * What the wrapper is, both here and in the renderer.
 *
 * A tag of its own rather than a `div`: react-markdown looks its components
 * up by tag name, and a name nothing else in markdown produces is one the
 * renderer can answer without asking what any other element is.
 */
export const DISPLAY_MATH_TAG = 'chat-math-block';

/** What KaTeX marks a formula rendered in display mode with. */
const DISPLAY_CLASS = 'katex-display';

/**
 * Whether this element is a formula KaTeX rendered on a line of its own.
 * @param node - The element to judge.
 * @returns Whether it is a display formula.
 */
function isDisplayMath(node: Element): boolean {
  const className = node.properties['className'];
  return Array.isArray(className) && className.includes(DISPLAY_CLASS);
}

/**
 * Wrap every display formula in an element of our own.
 * @returns A rehype transformer.
 */
export function displayMathPlugin(): (tree: Root) => void {
  return (tree: Root): void => {
    /**
     * Wrap the display formulas among this node's children, then go deeper —
     * a formula can sit inside a quote or a list item as well as at the top.
     * @param node - The node whose children to look through.
     */
    const walk = (node: Root | Element): void => {
      node.children = node.children.map((child) => {
        if (child.type !== 'element') return child;
        walk(child);
        if (!isDisplayMath(child)) return child;
        return {
          type: 'element',
          tagName: DISPLAY_MATH_TAG,
          properties: {},
          children: [child],
        } satisfies Element;
      });
    };

    walk(tree);
  };
}
