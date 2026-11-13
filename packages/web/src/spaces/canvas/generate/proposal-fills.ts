// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Filling a placed generation's slots from the proposal's material nodes
 * (inner#1315).
 *
 * Which slot a fill names (`slotForParam`) and what lands in it
 * (`writeProposalFillsInDoc`) live in `@breatic/shared/canvas-model`
 * (`slot-fill.ts`, breatic#1488 §8.1); this is the shell that asks the size
 * cap and runs the body in one `CANVAS_UNDO` transaction.
 */

import type { ProposalNode } from '@breatic/shared';
import { nodeDataMap, writeProposalFillsInDoc } from '@breatic/shared/canvas-model';

import { CANVAS_UNDO } from '@web/data/yjs/canvas-space';
import { docName, getDoc } from '@web/data/yjs/manager';
import { writeSpaceDoc } from '@web/data/yjs/space-write';

/**
 * Write a placed generation's fills into its slots.
 *
 * Runs inside the placement's undo batch, after every node holds its
 * material. A fill the check let through always finds its slot and its
 * material; one that does not is skipped, so a single stale index cannot roll
 * the rest of the flow back.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space being placed into.
 * @param nodeId - The placed generation node.
 * @param node - Its proposal entry.
 * @param sources - Every proposal node, in the proposal's order.
 * @throws {never} Never.
 */
export function writeProposalFills(
  projectId: string,
  spaceId: string,
  nodeId: string,
  node: ProposalNode,
  sources: readonly ProposalNode[],
): void {
  if (!node.fills || !node.mode) return;
  const name = docName.canvasSpace(projectId, spaceId);
  const doc = getDoc(name);
  if (!nodeDataMap(doc, nodeId)) return;
  // Appending a file is an add, filling a one-item slot an edit: the
  // strongest is an add.
  writeSpaceDoc(name, { kind: 'add' }, () => {
    doc.transact(() => writeProposalFillsInDoc(doc, nodeId, node, sources), CANVAS_UNDO);
  });
}
