// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where the textblocks are, for tests that need to put a selection somewhere.
 *
 * BlockNote's model puts the text two levels down — a `blockContainer` holding
 * a `blockContent` — so no test can name a position by counting; it has to walk
 * the document. Every caller wants the same walk and a different slice of what
 * it finds: the first one, the one holding some text, the nth, all of them.
 */

import type { Node as PMNode } from '@tiptap/pm/model';

/** One textblock and the positions around it. */
export interface Textblock {
  /** The node itself. */
  node: PMNode;
  /** The position before it, which is what `nodeAt` takes. */
  before: number;
  /** The first position inside it. */
  start: number;
  /** The last position inside it. */
  end: number;
  /** The position after it, which with `before` is the node's whole range. */
  after: number;
}

/**
 * Every textblock in the document, in document order.
 *
 * Does not descend into one: a textblock's children are inline, and no caller
 * wants those.
 * @param doc - The document to walk.
 * @returns The textblocks.
 */
export function textblocks(doc: PMNode): Textblock[] {
  const found: Textblock[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) {
      return true;
    }
    found.push({
      node,
      before: pos,
      start: pos + 1,
      end: pos + node.nodeSize - 1,
      after: pos + node.nodeSize,
    });
    return false;
  });
  return found;
}

/**
 * The first textblock whose text reads exactly this.
 * @param doc - The document to walk.
 * @param text - The text to look for.
 * @returns That textblock, or undefined where no block reads it.
 */
export function textblockReading(
  doc: PMNode,
  text: string,
): Textblock | undefined {
  return textblocks(doc).find((block) => block.node.textContent === text);
}
