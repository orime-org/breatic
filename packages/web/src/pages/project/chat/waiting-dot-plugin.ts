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

/** Tags laid out as blocks, so the mark may sit directly inside one. */
const BLOCK_TAGS = new Set([
  'blockquote',
  'dd',
  'div',
  'dt',
  'figcaption',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'p',
  'pre',
  'section',
  'td',
  'th',
]);

/**
 * Whether the mark may sit directly inside this element.
 *
 * A `code` whose parent is a `pre` is the code block's own body and is laid
 * out as a block, so the mark rides the last characters in there. Anywhere
 * else `code` is an inline chip, and a mark inside one joins the chip.
 * @param node - The element to judge.
 * @param parent - The element holding it.
 * @returns True when the mark may sit among this element's children.
 */
function holdsTheMark(node: Element, parent: Element): boolean {
  if (node.tagName === 'code') return parent.tagName === 'pre';
  return BLOCK_TAGS.has(node.tagName);
}

/**
 * The slot the mark takes inside this block, as a block-level parent and the
 * index to insert after.
 *
 * The last characters on screen are often inside an inline element, and a mark
 * placed in there takes that element on: the line-through of a `del`, the chip
 * of an inline `code`, the hit area and accessible name of an `a`. The slot is
 * therefore recorded against the nearest block-level ancestor, which puts the
 * mark beside that inline element.
 * @param block - The block to search.
 * @returns The parent and index, or undefined when the block holds no
 * visible characters.
 */
function lastVisibleSlot(
  block: Element,
): { parent: Element; index: number } | undefined {
  let found: { parent: Element; index: number } | undefined;

  /**
   * Descend, keeping the last visible slot seen in document order.
   * @param parent - The element whose children to look through.
   * @param host - The nearest block-level element enclosing `parent`.
   * @param hostIndex - Where the subtree holding `parent` sits inside `host`.
   */
  const walk = (parent: Element, host: Element, hostIndex: number): void => {
    parent.children.forEach((child, index) => {
      const slot = parent === host ? index : hostIndex;
      if (isVisibleLiteral(child)) {
        found = { parent: host, index: slot };
      } else if (isElement(child)) {
        const nextHost = holdsTheMark(child, parent) ? child : host;
        walk(child, nextHost, nextHost === child ? -1 : slot);
      }
    });
  };

  walk(block, block, -1);
  return found;
}

/**
 * The last node carrying characters in this subtree, in document order.
 *
 * A fence's last line often ends inside a coloured span rather than beside
 * one: a string or a comment that runs over several lines is one token, and
 * the newline terminating the line that just arrived sits within it.
 * @param node - The node to look through.
 * @returns That node, or undefined when the subtree carries no characters.
 */
function lastLiteralIn(node: RootContent): { value: string } | undefined {
  if (isVisibleLiteral(node)) return node as unknown as { value: string };
  if (!isElement(node)) return undefined;
  for (let i = node.children.length - 1; i >= 0; i -= 1) {
    const child = node.children[i];
    if (child === undefined) continue;
    const found = lastLiteralIn(child);
    if (found !== undefined) return found;
  }
  return undefined;
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

    if (tail.tagName === 'pre') {
      // A code block renders its whitespace, and every line a fence has
      // received so far ends in the newline that terminates it. Sitting after
      // that newline puts the mark on the line below the characters it is
      // meant to ride, for as long as the block is streaming.
      const preceding = slot.parent.children[slot.index];
      const ending = preceding === undefined ? undefined : lastLiteralIn(preceding);
      if (ending !== undefined) {
        const printed = ending.value.replace(/\s+$/, '');
        if (printed !== ending.value) {
          // The whitespace moves out to the far side of the mark, which leaves
          // the mark itself outside the coloured span it follows -- a mark
          // placed inside one takes that token's colour.
          const trailing = ending.value.slice(printed.length);
          ending.value = printed;
          slot.parent.children.splice(slot.index + 1, 0, mark, { type: 'text', value: trailing });
          return;
        }
      }
    }

    slot.parent.children.splice(slot.index + 1, 0, mark);
  };
}
