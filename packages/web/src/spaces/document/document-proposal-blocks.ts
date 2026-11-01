// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** New Agent output normalized before its surviving roots receive trace IDs. */

import { blockToNode, nodeToBlock } from '@blocknote/core';
import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { deriveId } from '@breatic/shared';

import type { WrittenBlock } from '@web/spaces/document/document-external-media';
import { unfoldTables } from '@web/spaces/document/document-table-nodes';

/**
 * The stable ID of one actual root written by a proposal.
 * @param proposalId - The proposal being written.
 * @param index - Its surviving root's index.
 * @returns The root's trace ID.
 */
export function writtenBlockId(proposalId: string, index: number): string {
  return deriveId(`document-proposal:${proposalId}:${String(index)}`);
}

/**
 * Converts new output for its current context: a table inside a cell is
 * unfolded into the cell's own blocks. Existing document blocks are not passed
 * through this conversion. Each root takes the id the schema converter gives
 * it; descendant IDs, attributes and marks are retained.
 * @param blocks - The prepared new payload.
 * @param doc - The current document, supplying its schema and conversion context.
 * @param inCell - Whether the output currently lands inside a table cell.
 * @returns The actual output roots in reading order.
 * @throws {Error} If the schema cannot convert the payload.
 */
export function blocksInContext(
  blocks: readonly WrittenBlock[],
  doc: ProseMirrorNode,
  inCell: boolean,
): Array<WrittenBlock & { id: string }> {
  const fragment = Fragment.from(blocks.map((block) => blockToNode(block as never, doc.type.schema)));
  const normalized = inCell ? unfoldTables(fragment) : fragment;
  const output: Array<WrittenBlock & { id: string }> = [];
  normalized.forEach((node) => {
    output.push(nodeToBlock(node, doc) as WrittenBlock & { id: string });
  });
  return output;
}

/**
 * Converts new output for its current context, then assigns actual root IDs
 * derived from the proposal.
 * @param blocks - The prepared new payload.
 * @param doc - The current document, supplying its schema and conversion context.
 * @param inCell - Whether the output currently lands inside a table cell.
 * @param proposalId - The proposal supplying the root trace IDs.
 * @returns The actual output roots in reading order.
 * @throws {Error} If the schema cannot convert the payload.
 */
export function proposalBlocks(
  blocks: readonly WrittenBlock[],
  doc: ProseMirrorNode,
  inCell: boolean,
  proposalId: string,
): Array<WrittenBlock & { id: string }> {
  return blocksInContext(blocks, doc, inCell).map((block, index) => ({ ...block, id: writtenBlockId(proposalId, index) }));
}
