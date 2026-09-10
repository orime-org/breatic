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
 * Both answers come off `alignableUnder`, which is also what greys the slot.
 * A second enumerator is how the judgement and the act come to see different
 * blocks.
 */

import { updateBlockTr } from '@blocknote/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Selection, Transaction } from '@tiptap/pm/state';

import { alignableUnder } from '@web/spaces/document/document-align-model';
import {
  keepSelection,
  selectionBefore,
} from '@web/spaces/document/document-block-run';

/**
 * The rows the menu offers. `justify` is a fourth BlockNote takes and the demo
 * does not draw.
 */
export type Alignment = 'left' | 'center' | 'right';

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
 * @param editor - The editor.
 * @param alignment - Which row was pressed.
 */
export function runAlignment(editor: AlignEditor, alignment: Alignment): void {
  editor.transact((tr) => {
    const covered = alignableUnder(tr.doc, tr.selection);
    const before = selectionBefore(tr);
    for (const { pos } of covered) {
      // `updateBlockTr` is given the position before a `blockContainer`, and a
      // container opens with its content node, so the container is one back.
      const at = tr.mapping.map(pos - 1);
      if (!tr.doc.nodeAt(at)?.firstChild) {
        continue;
      }
      updateBlockTr(tr, at, { props: { textAlignment: alignment } } as never);
    }
    keepSelection(tr, before);
  });
}

/**
 * Which row reads as the one the selection is on.
 *
 * All the covered blocks or none: a selection whose blocks disagree is not on
 * any one alignment, and drawing the first block's row as active there would
 * claim the whole selection is where its first block is. A selection alignment
 * does not reach is not on one either — the slot is grey, and a row drawn
 * active under a grey slot says the menu speaks for blocks it does not.
 * @param editor - The editor.
 * @returns That row, or nothing.
 */
export function activeAlignment(editor: AlignEditor): Alignment | undefined {
  const { doc, selection } = editor.prosemirrorState;
  const covered = alignableUnder(doc, selection);
  if (covered.length === 0) {
    return undefined;
  }
  // The prop's own default is `left`, so a block that was never aligned reads
  // as left rather than as nothing.
  const first = covered[0]!.node.attrs['textAlignment'] as Alignment;
  return covered.every(({ node }) => node.attrs['textAlignment'] === first)
    ? first
    : undefined;
}
