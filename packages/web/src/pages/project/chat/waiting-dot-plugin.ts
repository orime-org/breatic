// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Puts the waiting mark where the reply currently ends.
 *
 * Runs last in the rehype list. `rehype-highlight` replaces a code element's
 * children wholesale, so anything inserted before it inside a fenced block is
 * dropped.
 *
 * The tag is one of ours rather than a `span`: react-markdown maps components
 * by tag name, and mapping `span` would swap out every token the highlighter
 * produced.
 */
import type { Element, Root, RootContent } from 'hast';

/** The element this plugin inserts; `components` turns it into the dot. */
export const WAITING_DOT_TAG = 'waiting-dot';

/**
 * Whether this node is an element.
 * @param node - Any hast node.
 * @returns True when it is an element.
 */
function isElement(node: RootContent): node is Element {
  return node.type === 'element';
}

/**
 * Whether this node carries characters other than whitespace.
 *
 * Two node types do. One is hast text. The other is `raw`: with no `rehype-raw`
 * here, a tag the model wrote stays a raw node and react-markdown prints its
 * characters, so those characters are part of the reply on screen and the mark
 * belongs after them.
 *
 * The newline between two blocks is a text node too. Taking the last one
 * without this check lands the mark as a direct child of a `ul` or a `table`,
 * the second of which the browser then moves out of the table entirely.
 * @param node - Any hast node.
 * @returns True when it carries visible characters.
 */
function isVisibleLiteral(node: RootContent): boolean {
  // `raw` reaches the tree from mdast-util-to-hast and is absent from hast's
  // own node union, so the type is read as a string.
  const type: string = node.type;
  if (type !== 'text' && type !== 'raw') return false;
  const { value } = node as { value?: unknown };
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * The top-level node the reply currently ends in.
 *
 * `remark-gfm` moves every footnote definition into a section at the end of
 * the document, so the last node in document order is not the last one to
 * arrive whenever the reply has cited one.
 * @param tree - The document.
 * @returns That node, or undefined when nothing has arrived yet.
 */
function tailNode(tree: Root): RootContent | undefined {
  for (let i = tree.children.length - 1; i >= 0; i -= 1) {
    const node = tree.children[i];
    if (node === undefined) continue;
    if (isElement(node)) {
      if (node.tagName === 'section' && node.properties['dataFootnotes'] !== undefined) {
        continue;
      }
      return node;
    }
    if (isVisibleLiteral(node)) return node;
  }
  return undefined;
}

/**
 * The parent holding the last visible characters inside this block, with the
 * index they sit at.
 * @param block - The block to search.
 * @returns The parent and index, or undefined when the block holds none.
 */
function lastVisibleSlot(
  block: Element,
): { parent: Element; index: number } | undefined {
  let found: { parent: Element; index: number } | undefined;

  /**
   * Descend, keeping the last visible slot seen in document order.
   * @param parent - The element whose children to look through.
   */
  const walk = (parent: Element): void => {
    parent.children.forEach((child, index) => {
      if (isVisibleLiteral(child)) found = { parent, index };
      else if (isElement(child)) walk(child);
    });
  };

  walk(block);
  return found;
}

/**
 * Insert the waiting mark at the end of what has arrived.
 * @returns A rehype transformer.
 */
export function waitingDotPlugin(): (tree: Root) => void {
  return (tree: Root): void => {
    const mark: Element = {
      type: 'element',
      tagName: WAITING_DOT_TAG,
      properties: {},
      children: [],
    };

    const tail = tailNode(tree);
    if (tail === undefined) {
      tree.children.push(mark);
      return;
    }

    if (!isElement(tail)) {
      // A tag the model wrote as its own block. Its characters print at the
      // top level, so the mark goes beside it there.
      tree.children.splice(tree.children.indexOf(tail) + 1, 0, mark);
      return;
    }

    const slot = lastVisibleSlot(tail);
    if (slot === undefined) {
      // A rule, a lone image, a fence whose first character has yet to
      // arrive: nothing inside to ride, so the mark follows the block.
      tree.children.splice(tree.children.indexOf(tail) + 1, 0, mark);
      return;
    }

    slot.parent.children.splice(slot.index + 1, 0, mark);
  };
}
