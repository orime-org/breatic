// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Turns the markers the model wrote into elements the panel can draw.
 *
 * The model is asked to mark a claim with the number of the source it came
 * from. That arrives as ordinary text -- `[1]` is not markdown for anything --
 * so it has to be picked out of the text nodes, and only where a source
 * actually stands behind the number: the model writes these itself, and a
 * chip built from a number it invented would point nowhere, which is what a
 * citation exists to rule out.
 *
 * Runs on the hast tree rather than on mdast, which is what keeps a link
 * whole. `[1](https://…)` is parsed as a link long before this sees it, and
 * its label lives inside an `a` element -- skipped here by name.
 */
import type { Element, Root, RootContent, Text } from 'hast';

/** What the marker looks like: a number in square brackets. */
const MARKER = /\[(\d{1,3})\]/g;

/**
 * Elements whose text is not prose the model wrote for the reader.
 *
 * `math` covers the whole MathML subtree KaTeX renders beside the visible
 * formula, whose `annotation` holds the LaTeX the model wrote -- the source a
 * reader copies a formula to get. A formula containing `[1]` would otherwise
 * have that source rewritten, and the chip spliced into a subtree KaTeX
 * clips out of sight.
 */
const NOT_PROSE = new Set(['a', 'code', 'pre', 'math']);

/**
 * Rewrite every resolvable marker into an element of its own.
 * @param numbers - The numbers a source stands behind.
 * @returns A rehype transformer.
 */
export function citationPlugin(numbers: ReadonlySet<number>): (tree: Root) => void {
  /**
   * Split one text node around the markers in it.
   * @param node - The text node.
   * @returns The pieces, or null when there was nothing to split.
   */
  function split(node: Text): RootContent[] | null {
    MARKER.lastIndex = 0;
    const out: RootContent[] = [];
    let at = 0;
    let match = MARKER.exec(node.value);
    while (match !== null) {
      const index = Number(match[1]);
      if (numbers.has(index)) {
        if (match.index > at) {
          out.push({ type: 'text', value: node.value.slice(at, match.index) });
        }
        out.push({
          type: 'element',
          tagName: 'citation-chip',
          properties: { index: String(index) },
          children: [],
        });
        at = match.index + match[0].length;
      }
      match = MARKER.exec(node.value);
    }
    if (out.length === 0) return null;
    if (at < node.value.length) out.push({ type: 'text', value: node.value.slice(at) });
    return out;
  }

  return (tree: Root): void => {
    /**
     * Walk one node's children, replacing text that carries markers.
     * @param node - The node whose children to look through.
     */
    const walk = (node: Root | Element): void => {
      const next: RootContent[] = [];
      let changed = false;
      for (const child of node.children) {
        if (child.type === 'text') {
          const pieces = split(child);
          if (pieces === null) {
            next.push(child);
            continue;
          }
          next.push(...pieces);
          changed = true;
          continue;
        }
        if (child.type === 'element' && !NOT_PROSE.has(child.tagName)) walk(child);
        next.push(child);
      }
      if (changed) node.children = next;
    };

    walk(tree);
  };
}
