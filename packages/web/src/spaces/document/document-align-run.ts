// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What pressing an alignment row does to the selection, and which row the menu
 * draws as active.
 *
 * Alignment is one of BlockNote's own block props, so a press is `updateBlockTr`
 * over the blocks the selection covers — the shape `document-block-run.ts` uses
 * for block type, and for the same reason: `editor.updateBlock` takes a block
 * or an id, while what enumerates the selection hands back content nodes and
 * their positions.
 *
 * Everything the slot shows and does comes off one list of blocks. The slot asks
 * one question — {@link alignFace} — and the answer covers all three states it
 * draws: grey where alignment reaches nothing, a lit row where the selection is
 * on one, no lit row where its blocks disagree. A press writes to the same list.
 */

import type { Node as PMNode } from '@tiptap/pm/model';
import type { Selection } from '@tiptap/pm/state';

import type { ToolEditor } from '@web/spaces/document/document-tool-button';
import { writeToBlocks } from '@web/spaces/document/document-block-run';
import {
  blocksUnder,
  rowOf,
  type BlockTypeId,
  type BlockUnder,
} from '@web/spaces/document/document-block-ticks';

/**
 * The rows the menu offers. `justify` is a fourth BlockNote takes and the demo
 * does not draw.
 */
export type Alignment = 'left' | 'center' | 'right';

/** The block types alignment has anything to say about. */
const ALIGNABLE = new Set<BlockTypeId>([
  'paragraph',
  'heading-1',
  'heading-2',
  'heading-3',
]);

/**
 * What the slot reads where the covered blocks are aligned differently.
 *
 * The slot is live — a press still moves them all to one alignment — and no row
 * is lit, since the selection is not on any one of them.
 */
export const MIXED_ALIGNMENT = 'mixed';

/**
 * What the slot reads where alignment reaches no block under the selection.
 *
 * The slot is drawn grey and its menu does not open, the treatment
 * `document-coming-tool.tsx` defines for a control that cannot act.
 */
export const NO_ALIGNABLE_BLOCK = 'none';

/**
 * The rows the menu draws, as a total record over {@link Alignment}: a fourth
 * row leaves this failing to compile until it says it is drawn.
 */
const DRAWN: Readonly<Record<Alignment, true>> = {
  left: true,
  center: true,
  right: true,
};

/**
 * Whether a block's `textAlignment` is one of the rows the menu draws.
 * @param value - What the prop holds, which the schema types as unknown.
 * @returns Whether the menu has a row for it.
 */
function isDrawn(value: unknown): value is Alignment {
  return typeof value === 'string' && Object.hasOwn(DRAWN, value);
}

/** Everything the slot draws, off one reading of the selection. */
export type AlignFace =
  | Alignment
  | typeof MIXED_ALIGNMENT
  | typeof NO_ALIGNABLE_BLOCK;

/**
 * The blocks under the selection that alignment reaches.
 *
 * One alignable block is enough for the slot to be live: aligning a selection
 * that runs from a heading into a code block still moves the heading.
 * @param doc - The document.
 * @param selection - The selection over it.
 * @returns Those blocks, in document order.
 */
function alignableUnder(doc: PMNode, selection: Selection): BlockUnder[] {
  return blocksUnder(doc, selection).filter(({ node }) => {
    const row = rowOf(node);
    return row !== undefined && ALIGNABLE.has(row);
  });
}

/**
 * Aligns every block under the selection that alignment reaches.
 *
 * Nothing is dispatched where no block is reached: `transact` only sends a
 * transaction that was written into, so pressing a row over a code block costs
 * nothing rather than emitting an empty step.
 *
 * The selection comes out where it went in. Alignment changes no block's type,
 * so `updateBlockTr` keeps the content it has and the press emits only
 * `AttrStep`, whose step map is empty — measured on a word selection, a
 * two-block selection and an `AllSelection`, all three unchanged. Block type
 * needs a restore because it replaces the content outright.
 * @param editor - The editor.
 * @param alignment - Which row was pressed.
 * @param over - The range to act on, where the press names one; the block
 *   handle hands in a range over the hovered block's content. Left out, it is
 *   the reader's own selection, which is what the bubble bar means.
 */
export function runAlignment(
  editor: ToolEditor,
  alignment: Alignment,
  over?: Selection,
): void {
  editor.transact((tr) => {
    const carried = tr.storedMarks;
    writeToBlocks(tr, alignableUnder(tr.doc, over ?? tr.selection), () => ({
      props: { textAlignment: alignment },
    }));
    // A press aimed at a range the reader is not standing in leaves the marks
    // they are carrying where they were. Any step clears them —
    // `prosemirror-state`'s `Transaction.addStep` sets `storedMarks` to null —
    // so a reader who pressed `Mod-b` at their caret and then coloured another
    // row would find the next character they typed no longer bold. Putting
    // them back is the last thing the transaction does, since a step after it
    // would clear them again.
    if (over !== undefined) {
      tr.setStoredMarks(carried);
    }
  });
}

/**
 * Everything the slot draws, off one reading of the selection.
 *
 * All the covered blocks agree or none of them is lit: drawing the first
 * block's row as active over a selection whose blocks differ would claim the
 * whole selection is where its first block is.
 *
 * An alignment the menu has no row for reads as mixed. BlockNote's prop takes
 * a fourth value, `justify`, which arrives through pasted markup; leaving it
 * unlit says "not one of these", which is what it is.
 * @param editor - The editor.
 * @returns The row the selection is on, {@link MIXED_ALIGNMENT}, or
 *   {@link NO_ALIGNABLE_BLOCK}.
 */
export function alignFace(editor: ToolEditor): AlignFace {
  const { doc, selection } = editor.prosemirrorState;
  return alignFaceOver(doc, selection);
}

/**
 * The same reading over an explicit range.
 *
 * The block handle stands a block in for a selection over its content and asks
 * this about that range, so the row it lights and the greying both speak about
 * the block the pointer is over rather than about wherever the reader left
 * their caret.
 * @param doc - The document.
 * @param over - The range to read.
 * @returns The row that range is on, {@link MIXED_ALIGNMENT}, or
 *   {@link NO_ALIGNABLE_BLOCK}.
 */
export function alignFaceOver(doc: PMNode, over: Selection): AlignFace {
  const covered = alignableUnder(doc, over);
  if (covered.length === 0) {
    return NO_ALIGNABLE_BLOCK;
  }
  // The prop's own default is `left`, so a block that was never aligned reads
  // as left rather than as nothing.
  const first: unknown = covered[0]!.node.attrs['textAlignment'];
  const agree = covered.every(
    ({ node }) => node.attrs['textAlignment'] === first,
  );
  return agree && isDrawn(first) ? first : MIXED_ALIGNMENT;
}
