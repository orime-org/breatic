// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The two edges of the body as positions (design §5.10.5): where a selection
 * that runs past the first or last block ends (`document-body-edge-selection.ts`).
 */

import type { Node } from '@tiptap/pm/model';

/** Which end of the body. */
export type BodyEdge = 'start' | 'end';

/**
 * The position of an edge of the body.
 * @param doc - The document.
 * @param edge - Which edge.
 * @returns `2`, inside the first root block before its content, for the
 *   start; `size - 2`, inside the last root block after all of it, for the
 *   end. No text position is either: text sits one level deeper, inside a
 *   block's content node.
 */
export function bodyEdgePos(doc: Node, edge: BodyEdge): number {
  return edge === 'start' ? 2 : doc.content.size - 2;
}

/**
 * Which edge a position is, if it is one.
 * @param doc - The document.
 * @param pos - The position.
 * @returns The edge, or null for any other position.
 */
export function bodyEdgeAt(doc: Node, pos: number): BodyEdge | null {
  if (pos === bodyEdgePos(doc, 'start')) return 'start';
  if (pos === bodyEdgePos(doc, 'end')) return 'end';
  return null;
}
