// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What pressing a block type row does to the selection.
 *
 * §3.2: the block gains the row that was pressed, whatever is mutually
 * exclusive with it goes, and whatever is not stays. Pressing a row the
 * selection already carries is a cancel — except on the five content rows that
 * are not lists, where there is nothing to cancel and no transaction is
 * dispatched at all.
 *
 * In BlockNote's flat model each of those is one node's type and props, so the
 * whole press is `updateBlockTr` per block inside one transaction. The three
 * things the nested model needed a transform for — lifting items out of their
 * lists, wrapping a run in a quote, splitting a list at the selection's edges —
 * have no counterpart here: a quote is a prop, and a list item is a block type
 * rather than a container.
 *
 * Which rows a selection carries is `document-block-ticks.ts`. Reading the
 * cancel off `tickedOver` rather than off a second judgement of its own keeps
 * the two answers from drifting: the row the menu shows ticked is the row that
 * cancels.
 */

import { updateBlockTr } from '@blocknote/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import type { Selection, Transaction } from '@tiptap/pm/state';

import {
  ORDERED_LIST,
  QUOTED,
} from '@web/spaces/document/document-list-block';
import {
  LEVEL_OF_ROW,
  tickedOver,
  type BlockTypeId,
} from '@web/spaces/document/document-block-ticks';

/** What the editor object offers this file. */
export interface RunEditor {
  transact: <T>(run: (tr: Transaction) => T) => T;
}

/** The block type each non-heading row turns a block into. */
const TYPE_OF_ROW: Readonly<Partial<Record<BlockTypeId, string>>> = {
  paragraph: 'paragraph',
  'bullet-list': 'bulletListItem',
  'ordered-list': ORDERED_LIST,
  'task-list': 'checkListItem',
  'code-block': 'codeBlock',
};

/** The rows that are a list, and so have something to cancel. */
const LIST_ROWS: ReadonlySet<BlockTypeId> = new Set<BlockTypeId>([
  'bullet-list',
  'ordered-list',
  'task-list',
]);

/** What one block is asked to become. */
interface Update {
  readonly type?: string;
  readonly props: Readonly<Record<string, unknown>>;
}

/**
 * Where every block the selection covers begins.
 *
 * `updateBlockTr` is given the position before a `blockContainer`, and a
 * container opens with its content node, so the content node's own position is
 * one past it.
 * @param doc - The document.
 * @param selection - The selection over it.
 * @returns Those positions, in document order.
 */
function blockPositions(doc: PMNode, selection: Selection): number[] {
  const found: number[] = [];
  doc.nodesBetween(selection.from, selection.to, (node, pos) => {
    if (!node.isTextblock) {
      return true;
    }
    found.push(pos - 1);
    return false;
  });
  return found;
}

/**
 * What one block becomes.
 *
 * Props the update does not name are kept: `updateBlockTr` merges them over the
 * node's own attributes and then drops whatever the new type has no attribute
 * for. That is what carries a quote across a type change, and what takes the
 * number off a numbered heading the moment it stops being a heading.
 *
 * The five content rows that are not lists have no cancel branch because they
 * need none: asking a block to become what it already is names the type and
 * props it already has, and `updateBlockTr` emits a step only for an attribute
 * that actually changed. A6's "no transaction dispatched" therefore falls out
 * of the update being empty rather than out of a case that skips it.
 * @param content - The block's content node.
 * @param id - Which row was pressed.
 * @param cancelling - Whether the selection already carries that row.
 * @returns The update.
 */
function updateFor(
  content: PMNode,
  id: BlockTypeId,
  cancelling: boolean,
): Update {
  if (id === 'quote') {
    return { props: { [QUOTED]: !cancelling } };
  }
  if (cancelling && LIST_ROWS.has(id)) {
    // Taking the ordered row off a numbered heading takes the number, not the
    // heading (§3.2): being ordered is a prop there, and a block type only for
    // the list item.
    if (id === 'ordered-list' && content.type.name === 'heading') {
      return { props: { numbered: false } };
    }
    return { type: 'paragraph', props: {} };
  }

  const level = LEVEL_OF_ROW[id];
  if (level !== undefined) {
    return {
      type: 'heading',
      props: {
        level,
        // An ordered item becoming a heading stays ordered — the one pair that
        // coexists. A heading changing level keeps whichever it already was.
        numbered:
          content.type.name === ORDERED_LIST ||
          content.attrs['numbered'] === true,
      },
    };
  }
  if (id === 'ordered-list' && content.type.name === 'heading') {
    return { type: 'heading', props: { numbered: true } };
  }
  return { type: TYPE_OF_ROW[id]!, props: {} };
}

/**
 * Runs a row against the selection, as one transaction.
 *
 * Nothing is dispatched where every block is left alone: `transact` only sends
 * a transaction that was written into, which is what makes pressing a content
 * row the block already is cost nothing (A6).
 *
 * The reader's selection is put back at the end. `updateBlockTr` replaces the
 * node it changes, and a replacement collapses whatever selection sat inside
 * it — measured, a press over three selected paragraphs left the selection
 * empty, which takes the bar off screen (`SelectionBubbleBar`'s `isWarranted`
 * wants text in it) and leaves the reader selecting the same text again to
 * press a second row.
 * @param editor - The editor.
 * @param id - Which row.
 */
export function runBlockType(editor: RunEditor, id: BlockTypeId): void {
  editor.transact((tr) => {
    const positions = blockPositions(tr.doc, tr.selection);
    const cancelling = tickedOver(tr.doc, tr.selection).has(id);
    const written = tr.mapping.maps.length;
    const { anchor, head } = tr.selection;
    for (const origin of positions) {
      const at = tr.mapping.map(origin);
      const content = tr.doc.nodeAt(at)?.firstChild;
      if (!content) {
        continue;
      }
      updateBlockTr(tr, at, updateFor(content, id, cancelling) as never);
    }
    if (tr.mapping.maps.length === written) {
      return;
    }
    // Only the steps this press added, so the two ends travel the same
    // distance the text under them did.
    const carry = tr.mapping.slice(written);
    tr.setSelection(
      TextSelection.between(
        tr.doc.resolve(carry.map(anchor)),
        tr.doc.resolve(carry.map(head)),
      ),
    );
  });
}

/**
 * Whether the menu's rows can act on this selection.
 *
 * Every row answers the same, so the answer takes no row: in the flat model any
 * block can become any of the nine, and the only selection none of them reach
 * is one covering no block at all. A row the selection already carries is
 * ticked rather than greyed — the tick already says "you are here", and greying
 * it too would be two marks for one fact.
 * @param editor - The editor.
 * @returns Whether the selection holds a block.
 */
export function canRunBlockType(editor: RunEditor): boolean {
  return editor.transact(
    (tr) => blockPositions(tr.doc, tr.selection).length > 0,
  );
}
