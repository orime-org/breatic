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
 *   成员不相交 invariant detaches it from any previous group);
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
  if (hit && hit.id !== currentGroup?.id) {
    return { action: 'add', groupId: hit.id };
  }
  if (!hit && currentGroup) {
    return { action: 'remove', groupId: currentGroup.id };
  }
  return { action: 'none' };
}
