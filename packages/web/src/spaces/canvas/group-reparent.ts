// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Pure drag-stop reparent planner (group redesign 2026-06-23). On
 * `onNodeDragStop` the canvas decides, per dragged node, which Group it now
 * belongs to — the single rule: the Group whose rect contains the node's
 * CENTER point. A node entering a Group's bounds joins it; a member whose center
 * leaves its Group becomes top-level; a member whose center stays in keeps its
 * Group even if its body overflows (the canvas then auto-expands the Group, see
 * `expandGroupToWrap`). Kept ReactFlow-agnostic (absolute rects in, decisions
 * out) so the membership rule is unit-tested in isolation; the canvas converts
 * coordinates and writes Yjs.
 */

import {
  groupContainsMemberCenter,
  toRelativePosition,
  type Point,
  type Rect,
} from '@web/spaces/canvas/group-geometry';

/** A node being dropped, with its current Group and absolute rect. */
export interface DraggedNode {
  id: string;
  /** Current parent Group id, if the node is already a member. */
  parentId?: string;
  /** Absolute bounding rect at drop. */
  rect: Rect;
}

/** A Group the dropped node might land in. */
export interface GroupRef {
  id: string;
  /** The Group's absolute rect. */
  rect: Rect;
  /**
   * Whether the Group is locked — a locked Group's membership is frozen, so it
   * never accepts a dragged-in node (excluded as a reparent target).
   */
  locked?: boolean;
}

/** The membership outcome for one dropped node. */
export interface ReparentDecision {
  nodeId: string;
  /** The Group the node now belongs to, or `null` to become top-level. */
  targetGroupId: string | null;
  /** True when the membership changed (target differs from the current parent). */
  changed: boolean;
}

/**
 * Decide, per dragged node, which Group (if any) it now belongs to — the Group
 * whose rect contains the node's center. A node never reparents into itself (a
 * Group dragged over another is excluded by id), so dragging a Group yields no
 * membership change here.
 * @param dragged - Every dropped node with its current parent + absolute rect.
 * @param groups - The candidate Groups with their absolute rects.
 * @returns One reparent decision per dragged node.
 */
export function planGroupDragStop(
  dragged: ReadonlyArray<DraggedNode>,
  groups: ReadonlyArray<GroupRef>,
): ReparentDecision[] {
  return dragged.map((node) => {
    const target = groups.find(
      (group) =>
        group.id !== node.id &&
        // A locked Group's structure is frozen — never accept a dragged-in node.
        group.locked !== true &&
        groupContainsMemberCenter(group.rect, node.rect),
    );
    const targetGroupId = target?.id ?? null;
    const currentParent = node.parentId ?? null;
    return { nodeId: node.id, targetGroupId, changed: targetGroupId !== currentParent };
  });
}

/** A loose (top-level) node a Group resize might absorb, with its absolute rect. */
export interface LooseNode {
  id: string;
  /** Absolute bounding rect. */
  rect: Rect;
}

/** A resize-driven reparent: a loose node's new Group + parent-relative position. */
export interface ResizeJoin {
  id: string;
  parentId: string;
  position: Point;
}

/**
 * Decide which loose (top-level) nodes a Group's resize now contains: after the
 * Group is resized, any standalone node whose CENTER falls inside the new Group
 * rect joins it — the same center-in membership rule the drag path uses
 * ({@link groupContainsMemberCenter}), extended to resize. The caller passes
 * only loose candidates (top-level, non-group, excluding the Group itself); each
 * returned entry reparents the node into the Group at a parent-relative position.
 * Resize only absorbs loose nodes — it never expels existing members (the native
 * resize clamp keeps them ≥ padding inside).
 * @param groupId - The resized Group's id.
 * @param groupRect - The Group's new absolute rect.
 * @param looseNodes - Candidate top-level nodes with absolute rects.
 * @returns One join (id + parent-relative position) per node whose center entered the Group.
 */
export function planResizeJoin(
  groupId: string,
  groupRect: Rect,
  looseNodes: ReadonlyArray<LooseNode>,
): ResizeJoin[] {
  const joins: ResizeJoin[] = [];
  for (const node of looseNodes) {
    if (!groupContainsMemberCenter(groupRect, node.rect)) continue;
    joins.push({
      id: node.id,
      parentId: groupId,
      position: toRelativePosition(node.rect, groupRect),
    });
  }
  return joins;
}
