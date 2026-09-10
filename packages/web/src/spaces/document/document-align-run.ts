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
import type { Selection, Transaction } from '@tiptap/pm/state';

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

/** What the editor object offers this file. */
export interface AlignEditor {
  transact: <T>(run: (tr: Transaction) => T) => T;
  prosemirrorState: { doc: PMNode; selection: Selection };
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
 */
export function runAlignment(editor: AlignEditor, alignment: Alignment): void {
  editor.transact((tr) => {
    writeToBlocks(tr, alignableUnder(tr.doc, tr.selection), () => ({
      props: { textAlignment: alignment },
    }));
  });
}

/**
 * Everything the slot draws, off one reading of the selection.
 *
 * All the covered blocks agree or none of them is lit: drawing the first
 * block's row as active over a selection whose blocks differ would claim the
 * whole selection is where its first block is.
 * @param editor - The editor.
 * @returns The row the selection is on, {@link MIXED_ALIGNMENT}, or
 *   {@link NO_ALIGNABLE_BLOCK}.
 */
export function alignFace(editor: AlignEditor): AlignFace {
  const { doc, selection } = editor.prosemirrorState;
  const covered = alignableUnder(doc, selection);
  if (covered.length === 0) {
    return NO_ALIGNABLE_BLOCK;
  }
  // The prop's own default is `left`, so a block that was never aligned reads
  // as left rather than as nothing.
  const first = covered[0]!.node.attrs['textAlignment'] as Alignment;
  return covered.every(({ node }) => node.attrs['textAlignment'] === first)
    ? first
    : MIXED_ALIGNMENT;
}
