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
import type { Element, Root, RootContent, Text } from 'hast';

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
 * Whether this node is text carrying something other than whitespace.
 *
 * The newline between two blocks is a text node too. Taking the last text node
 * without this check lands the mark as a direct child of a `ul` or a `table`,
 * the second of which the browser then moves out of the table entirely.
 * @param node - Any hast node.
 * @returns True when it is a text node with visible characters.
 */
function isVisibleText(node: RootContent): node is Text {
  return node.type === 'text' && node.value.trim() !== '';
}

/**
 * The block the model is currently writing into.
 *
 * `remark-gfm` moves every footnote definition into a section at the end of
 * the document, so the last block in document order is not the last block to
 * arrive whenever the reply has cited one.
 * @param tree - The document.
 * @returns That block, or undefined when the document holds no elements.
 */
function blockBeingWritten(tree: Root): Element | undefined {
  for (let i = tree.children.length - 1; i >= 0; i -= 1) {
    const node = tree.children[i];
    if (node === undefined || !isElement(node)) continue;
    if (node.tagName === 'section' && node.properties['dataFootnotes'] !== undefined) {
      continue;
    }
    return node;
  }
  return undefined;
}

/**
 * The parent holding the last visible text inside this block, with the index
 * that text sits at.
 * @param block - The block to search.
 * @returns The parent and index, or undefined when the block holds no visible text.
 */
function lastVisibleTextSlot(
  block: Element,
): { parent: Element; index: number } | undefined {
  let found: { parent: Element; index: number } | undefined;

  /**
   * Descend, keeping the last visible text slot seen in document order.
   * @param parent - The element whose children to look through.
   */
  const walk = (parent: Element): void => {
    parent.children.forEach((child, index) => {
      if (isVisibleText(child)) found = { parent, index };
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

    const block = blockBeingWritten(tree);
    if (block === undefined) {
      tree.children.push(mark);
      return;
    }

    const slot = lastVisibleTextSlot(block);
    if (slot === undefined) {
      // A rule, a lone image, a fence whose first character has yet to
      // arrive: nothing inside to ride, so the mark follows the block.
      tree.children.splice(tree.children.indexOf(block) + 1, 0, mark);
      return;
    }

    slot.parent.children.splice(slot.index + 1, 0, mark);
  };
}
