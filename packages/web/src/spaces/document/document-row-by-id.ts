// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where a row is in the document, asked by the id the block carries.
 *
 * The id is what every gesture in this Space holds onto while the document
 * moves under it — a drag in flight, a menu waiting to be pressed, a selection
 * being put back — because positions go stale on a co-editor's keystroke and
 * an id does not. Three modules were each walking the document for one, and a
 * walk is easy to get subtly wrong in different ways: this is the one walk.
 */

import type { Node as PMNode } from '@tiptap/pm/model';

/** A row as the document holds it right now. */
export interface RowInDocument {
  /** The `blockContainer` node, nested blocks and all. */
  readonly node: PMNode;
  /** Where it starts. */
  readonly from: number;
  /** Where it ends. */
  readonly to: number;
}

/**
 * The block container carrying that id, as the document holds it now.
 *
 * The CONTAINER rather than its content: `BlockContainer.ts:27` is
 * `blockContent blockGroup?`, so the container is what holds the row's own
 * words together with anything indented under it.
 * @param doc - The document to look in.
 * @param blockId - Which row.
 * @returns The row, or undefined when the document no longer holds it.
 */
export function rowById(
  doc: PMNode,
  blockId: string,
): RowInDocument | undefined {
  let found: RowInDocument | undefined;
  doc.descendants((node, pos) => {
    if (found !== undefined) return false;
    if (node.attrs['id'] !== blockId) return true;
    found = { node, from: pos, to: pos + node.nodeSize };
    return false;
  });
  return found;
}

/**
 * Where that row's own words start and end, leaving nested blocks out.
 *
 * INSIDE the content node, which is where a caret or a selection goes: the
 * node sits one step inside the container and its words one step inside it
 * again. A range over the container would take everything indented under the
 * row with it, and a range over the content node's own boundaries is not a
 * place text can sit.
 * @param row - The row to read.
 * @returns Where the row's words start and end, or undefined when it holds
 * none.
 */
export function contentRangeOf(
  row: RowInDocument,
): { from: number; to: number } | undefined {
  const content = row.node.firstChild;
  if (content === null) return undefined;
  const from = row.from + 2;
  return { from, to: from + content.content.size };
}
