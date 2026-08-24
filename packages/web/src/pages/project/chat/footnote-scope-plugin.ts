// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Keeps one reply's footnote heading id to itself.
 *
 * `remarkRehypeOptions.clobberPrefix` scopes the note and reference ids, and
 * `mdast-util-to-hast` writes the heading's own id after spreading the options
 * it was given (footer.js:236), so that one stays fixed. Every reply in a
 * conversation renders into the same document, which leaves several elements
 * carrying it and the `aria-describedby` on each marker resolving to whichever
 * reply came first.
 */
import type { Element, Root } from 'hast';

/** What the library writes on the footnote section's heading. */
const LABEL_ID = 'footnote-label';

/**
 * Prefix the footnote heading's id and every reference to it.
 * @param scope - A value unique to the message being rendered.
 * @returns A rehype transformer.
 */
export function footnoteScopePlugin(scope: string): (tree: Root) => void {
  const scoped = `${scope}-${LABEL_ID}`;

  return (tree: Root): void => {
    /**
     * Rewrite the id and every reference to it, throughout this subtree.
     * @param node - The node whose children to look through.
     */
    const walk = (node: Root | Element): void => {
      for (const child of node.children) {
        if (child.type !== 'element') continue;
        // Matched by value: the heading's `id` and the `aria-describedby` on
        // every marker both hold it, hast spells attribute names its own way,
        // and it keeps an id-list attribute as an array.
        for (const [key, value] of Object.entries(child.properties)) {
          if (value === LABEL_ID) child.properties[key] = scoped;
          else if (Array.isArray(value) && value.includes(LABEL_ID)) {
            child.properties[key] = value.map((one) => (one === LABEL_ID ? scoped : one));
          }
        }
        walk(child);
      }
    };

    walk(tree);
  };
}
