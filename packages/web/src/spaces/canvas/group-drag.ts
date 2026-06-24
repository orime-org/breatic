// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Pure drag-stop orchestration for the Group model (group redesign). Turns
 * one drag-stop (1 node for a single drag, N for a marquee) into the Yjs writes:
 *   - **reparents** — members whose membership changed (center entered/left a
 *     Group): new `parentId` + position (relative when joining, absolute when
 *     leaving).
 *   - **positions** — dragged Groups (absolute; children follow natively via
 *     ReactFlow `parentId`) and members that just moved within the same parent.
 *   - **expansions** — Groups grown to wrap an in-group member whose body
 *     overflows (only-expand; the Group never auto-shrinks). The expand mutation
 *     reanchors members, so positions here are relative to the pre-expand
 *     top-left and are applied BEFORE the expansion.
 *
 * Kept ReactFlow-agnostic (absolute rects in, ops out) so the membership +
 * only-expand invariants are unit-tested in isolation; the canvas resolves
 * ReactFlow coordinates to absolute and applies the ops in one transaction.
 */

import {
  expandGroupToWrap,
  toRelativePosition,
  type Rect,
} from '@web/spaces/canvas/group-geometry';
import {
  planGroupDragStop,
  type GroupRef,
} from '@web/spaces/canvas/group-reparent';

/** A node in absolute canvas coordinates, for drag-stop planning. */
export interface DragNode {
  id: string;
  type: string;
  /** Current parent Group id, if the node is a member. */
  parentId?: string;
  /** Absolute top-left position. */
  absPos: { x: number; y: number };
  /** Rendered size. */
  size: { width: number; height: number };
  /** Whether a Group node is locked — a locked Group never accepts dragged-in nodes. */
  locked?: boolean;
}

/** A reparent write: a member's new Group + position. */
interface ReparentOp {
  id: string;
  parentId: string | null;
  position: { x: number; y: number };
}

/** A position write: a Group's new top-left or a member moved within its parent. */
interface PositionOp {
  id: string;
  position: { x: number; y: number };
}

/** A Group expansion: the new rect wrapping an overflowing in-group member. */
interface ExpansionOp {
  groupId: string;
  position: { x: number; y: number };
  width: number;
  height: number;
}

/** Every Yjs write a Group-model drag-stop implies. */
export interface GroupDragOps {
  reparents: ReparentOp[];
  positions: PositionOp[];
  expansions: ExpansionOp[];
}

/**
 * The node's absolute bounding rect.
 * @param node - The drag node.
 * @returns Its absolute rect.
 */
function rectOf(node: DragNode): Rect {
  return {
    x: node.absPos.x,
    y: node.absPos.y,
    width: node.size.width,
    height: node.size.height,
  };
}

/**
 * Plan every Yjs write for one drag-stop in the Group model. Dragged members
 * reparent by their center point; dragged Groups persist their absolute
 * position; each Group auto-expands (only-expand) to wrap any in-group member
 * whose body overflows.
 * @param dragged - Every node ReactFlow moved in this drag (absolute coordinates).
 * @param allNodes - All current nodes (absolute), for Group hit-testing + membership.
 * @returns The reparents, positions, and Group expansions to apply.
 */
export function planGroupDrag(
  dragged: ReadonlyArray<DragNode>,
  allNodes: ReadonlyArray<DragNode>,
): GroupDragOps {
  const groups = allNodes.filter((node) => node.type === 'group');
  const groupById = new Map(groups.map((group) => [group.id, group]));

  const draggedMembers = dragged.filter((node) => node.type !== 'group');
  const groupRefs: GroupRef[] = groups.map((group) => ({
    id: group.id,
    rect: rectOf(group),
    locked: group.locked,
  }));
  const decisions = planGroupDragStop(
    draggedMembers.map((node) => ({
      id: node.id,
      parentId: node.parentId,
      rect: rectOf(node),
    })),
    groupRefs,
  );
  const decisionById = new Map(decisions.map((d) => [d.nodeId, d]));

  const reparents: ReparentOp[] = [];
  const positions: PositionOp[] = [];

  for (const node of dragged) {
    if (node.type === 'group') {
      // a dragged Group persists its absolute position; children follow natively
      positions.push({ id: node.id, position: node.absPos });
      continue;
    }
    const decision = decisionById.get(node.id);
    if (decision !== undefined && decision.changed) {
      const targetGroup =
        decision.targetGroupId !== null
          ? groupById.get(decision.targetGroupId)
          : undefined;
      if (targetGroup !== undefined) {
        reparents.push({
          id: node.id,
          parentId: targetGroup.id,
          position: toRelativePosition(node.absPos, targetGroup.absPos),
        });
      } else {
        reparents.push({ id: node.id, parentId: null, position: node.absPos });
      }
      continue;
    }
    // membership unchanged — persist in the right coordinate space
    const parent = node.parentId !== undefined ? groupById.get(node.parentId) : undefined;
    positions.push({
      id: node.id,
      position:
        parent !== undefined
          ? toRelativePosition(node.absPos, parent.absPos)
          : node.absPos,
    });
  }

  /**
   * The node's parent Group after this drag: dragged members follow their
   * reparent decision; every other node keeps its current parent.
   * @param node - The node to resolve.
   * @returns The new parent Group id, or null when top-level.
   */
  const newParentOf = (node: DragNode): string | null => {
    const decision = decisionById.get(node.id);
    if (decision !== undefined && decision.changed) return decision.targetGroupId;
    return node.parentId ?? null;
  };

  const expansions: ExpansionOp[] = [];
  for (const group of groups) {
    const members = allNodes.filter(
      (node) => node.type !== 'group' && newParentOf(node) === group.id,
    );
    if (members.length === 0) continue;
    const groupRect = rectOf(group);
    const grown = expandGroupToWrap(groupRect, members.map(rectOf));
    if (
      grown.x !== groupRect.x ||
      grown.y !== groupRect.y ||
      grown.width !== groupRect.width ||
      grown.height !== groupRect.height
    ) {
      expansions.push({
        groupId: group.id,
        position: { x: grown.x, y: grown.y },
        width: grown.width,
        height: grown.height,
      });
    }
  }

  return { reparents, positions, expansions };
}
