// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the block handle needs to know about the block under the pointer.
 *
 * The side menu hands over one block; two questions follow from it, and both
 * have answers the library does not give. Whether the row draws a handle at
 * all, and which range a command off that row acts on.
 */

import { TextSelection, type Selection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';

import { QUOTED } from '@web/spaces/document/document-list-block';
import { ownContentPaints } from '@web/spaces/document/document-row-paints';

/** The part of a BlockNote block this file reads. */
export interface HoveredBlock {
  /** Which kind of block it is. */
  readonly type: string;
  /** Its props, of which the quote and the number are drawn. */
  readonly props?: Readonly<Record<string, unknown>>;
  /** Its own inline content, empty for a block that carries none. */
  readonly content?: readonly unknown[];
  /** Blocks nested under it. */
  readonly children?: readonly unknown[];
}

/**
 * Whether the reader sees anything on this row.
 *
 * The handle is offered for a row that shows something and withheld from one
 * that does not (menu system spec §5, `:457`). Which types can be invisible is
 * not decided here — it is the one judgement in `document-row-paints.ts`, which
 * the looks-empty hint asks as well. What this adds is the nesting: `content`
 * carries the block's OWN inline content while nested blocks live in `children`
 * (`BlockContainer.ts:27` is `blockContent blockGroup?`), so a list item whose
 * text was deleted still stands above the items indented under it.
 *
 * A HARD BREAK IS NOT SOMETHING TO SEE, which is the other half the hint
 * already decided and this has to read the same way. Through the block API it
 * arrives as a text item — measured, a row holding nothing but one
 * `Shift+Enter` comes back as `[{ type: 'text', text: '\n' }]`, so counting
 * items alone would call that row visible while the hint calls it empty.
 * @param block - The block under the pointer.
 * @returns True when the row shows something.
 */
export function rowPaintsSomething(block: HoveredBlock): boolean {
  if ((block.children?.length ?? 0) > 0) return true;

  const visibleInlines = (block.content ?? []).filter((item) => {
    const text = (item as { text?: unknown }).text;
    if (typeof text !== 'string') return true;
    return text.replace(/\n/gu, '') !== '';
  }).length;

  return ownContentPaints({
    type: block.type,
    quoted: block.props?.[QUOTED] === true,
    numbered: block.props?.['numbered'] === true,
    visibleInlines,
  });
}

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
  let found: { from: number; to: number } | undefined;
  doc.descendants((node, pos) => {
    if (found !== undefined) return false;
    if (node.attrs.id !== blockId) return true;
    const content = node.firstChild;
    if (content === null) return false;
    const from = pos + 1;
    found = { from, to: from + content.nodeSize };
    return false;
  });
  if (found === undefined) {
    throw new Error(`no block carries the id ${blockId}`);
  }
  return TextSelection.create(doc, found.from + 1, found.to - 1);
}
