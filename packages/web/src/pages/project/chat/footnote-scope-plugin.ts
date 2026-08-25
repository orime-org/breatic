// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
        // Located by element, not by value. A reply may carry the same
        // characters in an `alt`, an `href` or a `src` — `![footnote-label](d.png)`
        // is a picture of the markup an assistant is explaining — and those are
        // the model's own words.
        if (child.properties['id'] === LABEL_ID) child.properties['id'] = scoped;
        // The marker points at the heading through this one attribute, which
        // hast spells its own way and keeps as an id-list.
        if (child.properties['dataFootnoteRef'] !== undefined) {
          child.properties['ariaDescribedBy'] = [scoped];
        }
        walk(child);
      }
    };

    walk(tree);
  };
}
