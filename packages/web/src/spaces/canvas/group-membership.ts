// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Pure drag-end group membership logic (§7.5): when a single node is dropped,
 * decide whether it joins a group it now overlaps, leaves the group it was in,
 * or nothing changes. Kept ReactFlow-agnostic; the canvas hit-tests the
 * dragged node's center against each group's derived rect and applies the
 * returned action through the Yjs `addToGroup` / `removeFromGroup` bindings.
 */

import type { GroupRect } from '@web/spaces/canvas/group-geometry';

/** A group's derived container rect + its current members. */
export interface GroupBox {
  id: string;
  rect: GroupRect;
  childIds: string[];
  /** Whether the group is locked — a locked group's membership is frozen. */
  locked?: boolean;
}

/** The membership change a drop implies. */
export type GroupDrop =
  | { action: 'add'; groupId: string }
  | { action: 'remove'; groupId: string }
  | { action: 'none' };

/**
 * Whether a point falls within a rect (edge-inclusive).
 * @param rect - The rect in flow coordinates.
 * @param point - The point to test.
 * @param point.x - Point x.
 * @param point.y - Point y.
 * @returns True when the point is inside or on the rect's border.
 */
export function rectContains(
  rect: GroupRect,
  point: { x: number; y: number },
): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/**
 * Resolve the membership change for dropping node `draggedId` at `center`:
 * - lands inside a group it is not already in → **add** (the binding's
 *   disjoint-membership invariant detaches it from any previous group);
 * - was a member but now sits outside that group → **remove**;
 * - stayed inside its own group, or dropped on empty canvas while loose →
 *   **none**.
 * Overlapping groups (groups never nest but can visually overlap) resolve to
 * the first hit in `groups` order.
 * @param draggedId - Id of the node that was dropped.
 * @param center - The dropped node's center in flow coordinates.
 * @param center.x - Center x.
 * @param center.y - Center y.
 * @param groups - The groups to hit-test against (with current members).
 * @returns The membership change to apply.
 */
export function resolveGroupDrop(
  draggedId: string,
  center: { x: number; y: number },
  groups: ReadonlyArray<GroupBox>,
): GroupDrop {
  const currentGroup = groups.find((group) =>
    group.childIds.includes(draggedId),
  );
  const hit = groups.find(
    (group) => group.id !== draggedId && rectContains(group.rect, center),
  );
  // A locked group freezes its membership: nothing can join it, and its members
  // can't leave (members render draggable=false, so a leave rarely reaches here
  // — guard anyway).
  if (hit?.locked) return { action: 'none' };
  if (currentGroup?.locked) return { action: 'none' };
  if (hit && hit.id !== currentGroup?.id) {
    return { action: 'add', groupId: hit.id };
  }
  if (!hit && currentGroup) {
    return { action: 'remove', groupId: currentGroup.id };
  }
  return { action: 'none' };
}

/**
 * Ids of every node that is a member of a *locked* group — their position is
 * frozen, so the canvas renders them `draggable=false`. A locked group keeps
 * its members fixed in place; the group as a whole can still be dragged.
 * @param nodes - All canvas nodes (only group nodes with `data.locked` matter).
 * @returns The set of member ids belonging to locked groups.
 */
export function lockedGroupMemberIds(
  nodes: ReadonlyArray<{ type?: string; data?: unknown }>,
): Set<string> {
  const ids = new Set<string>();
  for (const node of nodes) {
    if (node.type !== 'group') continue;
    const data = node.data as
      | { locked?: boolean; childIds?: string[] }
      | undefined;
    if (!data?.locked) continue;
    for (const childId of data.childIds ?? []) ids.add(childId);
  }
  return ids;
}

/**
 * Ids of every node frozen by a lock — any node with `data.locked`, OR a member
 * of a locked group. A frozen node can be neither moved (rendered
 * `draggable=false`) nor deleted ({@link filterLockedDeletion}); both reuse this
 * one set so they stay in lockstep. A locked group's OWN id is included, so the
 * whole group is frozen in place — it cannot be dragged as a unit (reverses
 * group-lock-C's whole-group drag, decision 2026-06-20).
 * @param nodes - All canvas nodes (the `locked` flag is read from each `data`).
 * @returns The set of node ids frozen by a lock.
 */
export function lockedNodeIds(
  nodes: ReadonlyArray<{ id: string; type?: string; data?: unknown }>,
): Set<string> {
  const ids = lockedGroupMemberIds(nodes);
  for (const node of nodes) {
    if ((node.data as { locked?: boolean } | undefined)?.locked) ids.add(node.id);
  }
  return ids;
}

/**
 * Partition a requested deletion so locked structure survives: any locked node
 * (a locked group OR a locked standalone node), a locked group's members, AND
 * every edge touching a protected node are kept OUT of the deletion. Wire into
 * ReactFlow's `onBeforeDelete` (the pre-delete veto) — the post-hoc `onDelete`
 * can't stop ReactFlow from removing nodes/edges from the local buffer first,
 * nor from cascading a protected node's edges into the deletion (edges are part
 * of the frozen structure too).
 * @param nodes - The nodes ReactFlow is about to delete.
 * @param edges - The edges ReactFlow is about to delete (incl. cascaded ones).
 * @param allNodes - All canvas nodes, to resolve which nodes / groups are locked.
 * @returns The subset safe to delete (protected nodes + their edges removed).
 */
export function filterLockedDeletion<
  N extends { id: string },
  E extends { id: string; source: string; target: string },
>(
  nodes: ReadonlyArray<N>,
  edges: ReadonlyArray<E>,
  allNodes: ReadonlyArray<{ id: string; type?: string; data?: unknown }>,
): { nodes: N[]; edges: E[] } {
  // The frozen-by-lock set (any locked node + locked group members) is exactly
  // what can't be deleted — the same set the move-freeze path uses.
  const protectedIds = lockedNodeIds(allNodes);
  return {
    nodes: nodes.filter((node) => !protectedIds.has(node.id)),
    edges: edges.filter(
      (edge) =>
        !protectedIds.has(edge.source) && !protectedIds.has(edge.target),
    ),
  };
}
