// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which range a command off the block handle acts on.
 *
 * The side menu hands over one block, and the commands behind the menu read a
 * `Selection` — this is the mapping between the two, and the library does not
 * give it.
 */

import { TextSelection, type Selection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';

import {
  contentRangeOf,
  rowById,
} from '@web/spaces/document/document-row-by-id';

/**
 * A selection covering one block's own content and nothing indented under it.
 *
 * The commands behind the block type menu read a `Selection` rather than an
 * editor (`document-block-ticks.ts`, `document-block-run.ts`), because the
 * bubble bar acts on what the reader selected. The block handle acts on the
 * row the pointer is over instead, so this builds the selection that stands
 * for that row — WITHOUT dispatching it, which leaves the reader's own
 * selection, their caret and the undo stack untouched.
 *
 * The range covers the `blockContent` node alone. A `blockContainer` holds
 * `blockContent blockGroup?` (`BlockContainer.ts:27`), so a range over the
 * container would take every nested block with it.
 * @param doc - The document to look in.
 * @param blockId - Which block the pointer is over.
 * @returns A selection over that block's own content.
 * @throws {Error} When no block in the document carries that id.
 */
export function selectionOverBlockContent(doc: PMNode, blockId: string): Selection {
  const row = rowById(doc, blockId);
  const content = row === undefined ? undefined : contentRangeOf(row);
  if (content === undefined) {
    throw new Error(`no block carries the id ${blockId}`);
  }
  return TextSelection.create(doc, content.from, content.to);
}
