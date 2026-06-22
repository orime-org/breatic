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

import {
  computeGroupRect,
  type FrozenGroupRect,
  type GroupRect,
} from '@web/spaces/canvas/group-geometry';
import {
  resolveGroupDrop,
  type GroupBox,
} from '@web/spaces/canvas/group-membership';

/** Footprint assumed for a node ReactFlow has not measured yet. */
const NODE_FALLBACK_W = 160;
const NODE_FALLBACK_H = 96;

/** Shared empty set so the default `freezeMembershipIds` allocates nothing. */
const NO_FROZEN_MEMBERSHIP: ReadonlySet<string> = new Set();

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
 * Build the hit-test boxes for every group. For the **frozen** group (the one
 * whose member is being dragged), use the drag-start snapshot rect — a stable
 * full-container box, so a small in-group nudge no longer reads as "outside" and
 * dissolves a 2-member group (#1478). For every other group, derive the rect
 * from its members excluding the dragged node, so a member dragged OUT of its
 * own group still reads as "outside". A group with no resolvable rect is skipped.
 * @param flowNodes - The current flow nodes.
 * @param draggedId - The node being dropped (excluded from each non-frozen rect).
 * @param frozenGroup - The drag-start snapshot of the dragged member's group, or null.
 * @returns One {@link GroupBox} per group with a resolvable rect.
 */
function groupBoxesFor(
  flowNodes: ReadonlyArray<Node>,
  draggedId: string,
  frozenGroup: FrozenGroupRect | null,
): GroupBox[] {
  const boxes: GroupBox[] = [];
  for (const node of flowNodes) {
    if (node.type !== 'group') continue;
    const childIds = (node.data as { childIds?: string[] }).childIds ?? [];
    let rect: GroupRect | null;
    if (frozenGroup && node.id === frozenGroup.groupId) {
      rect = frozenGroup.rect;
    } else {
      const members = flowNodes.filter(
        (member) => childIds.includes(member.id) && member.id !== draggedId,
      );
      rect = computeGroupRect(members);
    }
    if (rect) {
      boxes.push({
        id: node.id,
        rect,
        childIds,
        locked: (node.data as { locked?: boolean }).locked,
      });
    }
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
 * @param freezeMembershipIds - Ids whose group membership must NOT be re-evaluated (members moving rigidly with a co-dragged group); their position still persists.
 * @param frozenGroup - The drag-start snapshot of the dragged member's group, or null (back-compat = per-member box, pre-#1478 behavior).
 * @returns The positions to persist + the membership changes to apply.
 */
export function planDragStop(
  draggedNodes: ReadonlyArray<Node>,
  allNodes: ReadonlyArray<Node>,
  freezeMembershipIds: ReadonlySet<string> = NO_FROZEN_MEMBERSHIP,
  frozenGroup: FrozenGroupRect | null = null,
): DragPersistPlan {
  const positions: NodePosition[] = [];
  const groupOps: GroupOp[] = [];
  for (const node of draggedNodes) {
    if (node.type === 'group') continue;
    positions.push({ id: node.id, position: node.position });
    // A member of a group that is itself in the dragged set moves rigidly with
    // its group, so its membership must not change. Re-running the hit-test
    // would compare it against a rect built from only the OTHER members
    // (groupBoxesFor excludes the evaluated node) — spread-apart members read as
    // "outside" and get removed, dissolving the group (#2). Skip the membership
    // resolution; the position above still persists (no snap-back).
    if (freezeMembershipIds.has(node.id)) continue;
    const drop = resolveGroupDrop(
      node.id,
      nodeCenter(node),
      groupBoxesFor(allNodes, node.id, frozenGroup),
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

/** A group's translation to persist, when the grabbed node is a group. */
export interface GroupMove {
  groupId: string;
  delta: { x: number; y: number };
}

/** Every Yjs write a drag-stop implies, across the group + loose nodes. */
export interface DragStopAllPlan {
  groupMove: GroupMove | null;
  positions: NodePosition[];
  groupOps: GroupOp[];
}

/**
 * Plan every Yjs write for one drag-stop, covering the mixed marquee case
 * where a group AND loose nodes are dragged together (#6). When the grabbed
 * node is the actively-dragged group, its translation is returned as
 * `groupMove`; independently, every loose (non-group) node in the selection
 * persists its position and resolves its own group-membership change via
 * {@link planDragStop}. The old `onNodeDragStop` returned right after moving
 * the group, dropping the loose nodes' positions so they snapped back when the
 * next Yjs mirror re-applied their stale positions.
 * @param grabbed - The node ReactFlow reports as grabbed (drives the group-move branch).
 * @param draggedNodes - Every co-dragged node (1 for a single drag, N for a marquee multi-select).
 * @param allNodes - All current flow nodes, for group hit-testing.
 * @param groupDrag - The active group-drag ref (id + drag-start origin), or null when no group drag is in flight.
 * @param frozenGroup - The drag-start snapshot of a dragged member's group, or null (forwarded to the per-member membership hit-test).
 * @returns The group move (or null) plus the loose-node positions and membership ops.
 */
export function planDragStopAll(
  grabbed: Node,
  draggedNodes: ReadonlyArray<Node>,
  allNodes: ReadonlyArray<Node>,
  groupDrag: { id: string; startX: number; startY: number } | null,
  frozenGroup: FrozenGroupRect | null = null,
): DragStopAllPlan {
  let groupMove: GroupMove | null = null;
  if (grabbed.type === 'group' && groupDrag && groupDrag.id === grabbed.id) {
    const dx = grabbed.position.x - groupDrag.startX;
    const dy = grabbed.position.y - groupDrag.startY;
    if (dx !== 0 || dy !== 0) {
      groupMove = { groupId: grabbed.id, delta: { x: dx, y: dy } };
    }
  }
  // Any group present in the dragged set carries its members as a rigid body.
  // Freeze every such member's membership so the per-member hit-test can't
  // dissolve the group (#2). The actively-dragged group's members are ALSO
  // position-owned by moveGroup, so drop them from per-node persistence entirely
  // to avoid double-writing their position; a merely co-selected group's members
  // still persist their (ReactFlow-moved) position so they don't snap back.
  const frozenMembership = new Set<string>();
  const groupMoveMembers = new Set<string>();
  for (const dragged of draggedNodes) {
    if (dragged.type !== 'group') continue;
    const childIds = (dragged.data as { childIds?: string[] }).childIds ?? [];
    for (const childId of childIds) {
      frozenMembership.add(childId);
      if (groupMove && dragged.id === groupMove.groupId) {
        groupMoveMembers.add(childId);
      }
    }
  }
  const { positions, groupOps } = planDragStop(
    draggedNodes.filter((dragged) => !groupMoveMembers.has(dragged.id)),
    allNodes,
    frozenMembership,
    frozenGroup,
  );
  return { groupMove, positions, groupOps };
}
