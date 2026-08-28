// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Pure drag-stop orchestration for the Group model (group redesign). Turns
 * one drag-stop (1 node for a single drag, N for a marquee) into the Yjs writes:
 *   - **reparents** — members whose membership changed (center entered/left a
 *     Group): new `parentId` + position (relative when joining, absolute when
 *     leaving).
 *   - **positions** — dragged Groups (absolute; children follow natively via
 *     ReactFlow `parentId`) and members that just moved within the same parent.
 *   - **expansions** — Groups grown to wrap an in-group member whose body
 *     overflows (only-expand; the Group never auto-shrinks). Only the Group's
 *     own rect is written; every member of it appears in **positions**, stated
 *     against the origin the expansion is moving it to.
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
  /** The Group this position is measured against, or null when absolute. */
  parentId: string | null;
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
 * @param heldByRemote - Nodes a remote gesture is moving. They still answer which
 *   Group a node belongs to; they take no part in a landing decision, and no
 *   Group is sized around them.
 * @param settled - The same nodes with every remote gesture put back where the
 *   document has it. Anything a remote is holding is measured from here: its
 *   on-screen rect is one the document has never had.
 * @param resizedByRemote - Groups a remote is RESIZING. A resize moves no
 *   member, so it subtracts its whole travel from each member's stored
 *   position — which only lands right if that position was measured against the
 *   Group's document origin. A drag carries its members along instead, so those
 *   stay measured against the origin on screen.
 * @returns The reparents, positions, and Group expansions to apply.
 */
export function planGroupDrag(
  dragged: ReadonlyArray<DragNode>,
  allNodes: ReadonlyArray<DragNode>,
  heldByRemote: ReadonlySet<string> = new Set(),
  settled: ReadonlyArray<DragNode> = allNodes,
  resizedByRemote: ReadonlySet<string> = new Set(),
): GroupDragOps {
  const groups = allNodes.filter((node) => node.type === 'group');
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const settledById = new Map(settled.map((node) => [node.id, node]));
  /**
   * The node as the document has it, for anything a remote is holding.
   * @param node - The node as this screen draws it.
   * @returns The settled node, or the given one when nothing holds it.
   */
  const draggedIds = new Set(dragged.map((node) => node.id));
  /**
   * The node as the document has it, for anything a remote is holding.
   *
   * A node in this drag is the exception: two people can hold one node, and
   * where this user just dropped it is what this drag-stop is committing.
   * @param node - The node as this screen draws it.
   * @returns The settled node, or the given one when this drag owns it.
   */
  const asSettled = (node: DragNode): DragNode =>
    heldByRemote.has(node.id) && !draggedIds.has(node.id)
      ? (settledById.get(node.id) ?? node)
      : node;

  const draggedMembers = dragged.filter((node) => node.type !== 'group');
  // A Group somebody else is dragging stays in the list and is marked instead:
  // its rect right now is one the document has never held, so it neither
  // receives a node nor is judged to have lost one.
  const groupRefs: GroupRef[] = groups.map((group) => ({
    id: group.id,
    rect: rectOf(group),
    locked: group.locked,
    heldByRemote: heldByRemote.has(group.id),
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
      positions.push({ id: node.id, position: node.absPos, parentId: null });
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
    // A Group being dragged elsewhere carries its members along, so a member
    // nudged inside it belongs at that spot in the Group and travels the rest
    // of the way with it — measured from the origin on screen. A resize moves
    // no member and subtracts its whole travel from every stored position, so
    // there the document origin is the one that lands right.
    const anchor =
      parent !== undefined && resizedByRemote.has(parent.id)
        ? (settledById.get(parent.id) ?? parent)
        : parent;
    positions.push({
      id: node.id,
      position:
        anchor !== undefined
          ? toRelativePosition(node.absPos, anchor.absPos)
          : node.absPos,
      parentId: parent !== undefined ? parent.id : null,
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
    // Growing a Group writes its position and size, and the rect it would grow
    // from is the one on screen -- an origin the document has never held. A
    // Group a remote is dragging is one this end writes nothing about, so its
    // wrap waits for a drag-stop after that gesture ends.
    if (heldByRemote.has(group.id)) continue;
    const members = allNodes.filter(
      (node) => node.type !== 'group' && newParentOf(node) === group.id,
    );
    if (members.length === 0) continue;
    const groupRect = rectOf(group);
    // A member somebody else is dragging is about to land somewhere this end
    // cannot know, and `expandGroupToWrap` only ever grows — a Group sized to
    // wrap it now keeps that size after it lands elsewhere. It still gets
    // restated below: the origin moving is about where every member sits, not
    // about who is holding one.
    const sizedAround = members.filter((node) => !heldByRemote.has(node.id));
    const grown = expandGroupToWrap(groupRect, sizedAround.map(rectOf));
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
      // The expansion moves the origin every member of this Group is measured
      // against, and the Group's own write says nothing about members — so
      // every one of them is stated against where the origin is going, the one
      // the pointer moved along with the ones it never touched. Each still
      // takes a single position write (#2010, acceptance 9), and each keeps the
      // absolute place it already had. A Group that only got bigger keeps its
      // origin, and with it every member's position.
      if (grown.x === groupRect.x && grown.y === groupRect.y) continue;
      const stated = new Map(
        [...reparents, ...positions].map((op) => [op.id, op]),
      );
      for (const member of members) {
        const from = asSettled(member);
        const position = {
          x: from.absPos.x - grown.x,
          y: from.absPos.y - grown.y,
        };
        const op = stated.get(member.id);
        if (op === undefined) {
          positions.push({ id: member.id, position, parentId: group.id });
        }
        else op.position = position;
      }
    }
  }

  // An expansion writes the Group's position along with its size, so a dragged
  // Group that also grew has already been placed — a second op for it would be
  // a second write of the one key (#2010, acceptance 9).
  const grown = new Set(expansions.map((e) => e.groupId));
  return {
    reparents,
    positions: positions.filter((op) => !grown.has(op.id)),
    expansions,
  };
}
