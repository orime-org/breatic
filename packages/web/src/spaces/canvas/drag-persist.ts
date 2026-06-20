// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Pure drag-stop persistence planner. ReactFlow's `onNodeDragStop` reports
 * every co-dragged node (its third argument) — a single node for a normal
 * drag, all selected nodes for a marquee multi-select drag. This module turns
 * that set into the Yjs writes to apply: each non-group node's new position,
 * plus any group membership change its drop implies. Kept ReactFlow-agnostic
 * (no hooks) so the multi-drag invariant is unit-tested in isolation; the
 * canvas executes the returned plan through the Yjs bindings.
 */

import type { Node } from '@xyflow/react';

import { computeGroupRect } from '@web/spaces/canvas/group-geometry';
import {
  resolveGroupDrop,
  type GroupBox,
} from '@web/spaces/canvas/group-membership';

/** Footprint assumed for a node ReactFlow has not measured yet. */
const NODE_FALLBACK_W = 160;
const NODE_FALLBACK_H = 96;

/** A node position to persist back to Yjs. */
interface NodePosition {
  id: string;
  position: { x: number; y: number };
}

/** A group membership change to apply for one dropped node. */
interface GroupOp {
  action: 'add' | 'remove';
  groupId: string;
  nodeId: string;
}

/** The Yjs writes a drag-stop implies, across every dragged node. */
export interface DragPersistPlan {
  positions: NodePosition[];
  groupOps: GroupOp[];
}

/**
 * A node's center in flow coordinates, from its measured size (or a default
 * before ReactFlow has measured it).
 * @param node - The flow node.
 * @returns The node's center point.
 */
function nodeCenter(node: Node): { x: number; y: number } {
  const width = node.measured?.width ?? NODE_FALLBACK_W;
  const height = node.measured?.height ?? NODE_FALLBACK_H;
  return { x: node.position.x + width / 2, y: node.position.y + height / 2 };
}

/**
 * Build the hit-test boxes for every group, excluding the dragged node from
 * each group's bounds so a member dragged out of its own group reads as
 * "outside" (the group's rect is its *other* members' bounds). A group with no
 * remaining members is skipped. `childIds` keeps the dragged node so its
 * current group is still detectable.
 * @param flowNodes - The current flow nodes.
 * @param draggedId - The node being dropped (excluded from each rect).
 * @returns One {@link GroupBox} per group with a resolvable rect.
 */
function groupBoxesFor(
  flowNodes: ReadonlyArray<Node>,
  draggedId: string,
): GroupBox[] {
  const boxes: GroupBox[] = [];
  for (const node of flowNodes) {
    if (node.type !== 'group') continue;
    const childIds = (node.data as { childIds?: string[] }).childIds ?? [];
    const members = flowNodes.filter(
      (member) => childIds.includes(member.id) && member.id !== draggedId,
    );
    const rect = computeGroupRect(members);
    if (rect) boxes.push({ id: node.id, rect, childIds });
  }
  return boxes;
}

/**
 * Plan the Yjs writes for a drag-stop across **all** dragged nodes — the fix
 * for the multi-select drag bug (#1432). ReactFlow moves every selected node
 * together but `onNodeDragStop` was only persisting the grabbed one, so the
 * rest snapped back when the Yjs mirror re-applied their stale positions. Each
 * non-group node persists its new position and independently resolves whether
 * the drop changed its group membership. Group nodes are skipped — a group has
 * no authoritative position (it is derived from members and moved via the
 * group drag path), so it must not be persisted here.
 * @param draggedNodes - Every node ReactFlow moved in this drag (1 for a single drag, N for a marquee multi-select).
 * @param allNodes - All current flow nodes, for group hit-testing.
 * @returns The positions to persist + the membership changes to apply.
 */
export function planDragStop(
  draggedNodes: ReadonlyArray<Node>,
  allNodes: ReadonlyArray<Node>,
): DragPersistPlan {
  const positions: NodePosition[] = [];
  const groupOps: GroupOp[] = [];
  for (const node of draggedNodes) {
    if (node.type === 'group') continue;
    positions.push({ id: node.id, position: node.position });
    const drop = resolveGroupDrop(
      node.id,
      nodeCenter(node),
      groupBoxesFor(allNodes, node.id),
    );
    if (drop.action === 'add') {
      groupOps.push({ action: 'add', groupId: drop.groupId, nodeId: node.id });
    } else if (drop.action === 'remove') {
      groupOps.push({
        action: 'remove',
        groupId: drop.groupId,
        nodeId: node.id,
      });
    }
  }
  return { positions, groupOps };
}
