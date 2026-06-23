// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Pure planner for "group the current selection". A group node has no
 * authoritative size (its geometry is derived from members at render), so this
 * computes the new group's stored position (members' padded top-left) and —
 * critically (#1477) — the deselected member nodes. Grouping must clear the
 * marquee members' local selection immediately; otherwise the Yjs mirror
 * round-trip window keeps a stale multi-selection and ReactFlow routes a
 * right-click to the SELECTION menu instead of the GROUP menu. Kept
 * ReactFlow-agnostic so the selection invariant is unit-tested in isolation; the
 * canvas builds the actual group node (`createEmptyGroup`) from `childIds` /
 * `position` and applies `nextNodes` to its render buffer.
 */

import type { Node } from '@xyflow/react';

import { computeGroupRect } from '@web/spaces/canvas/group-geometry';

/** The Yjs + local-state changes that creating a group from the selection implies. */
export interface GroupCreationPlan {
  /** Member ids for the new group's `childIds`. */
  childIds: string[];
  /** The new group node's stored position (members' padded bounding-box top-left). */
  position: { x: number; y: number };
  /** The render buffer with every grouped member's selection cleared (others kept by reference). */
  nextNodes: Node[];
}

/**
 * Plan creating a group from the selected nodes: its `childIds` + stored
 * `position`, plus the render buffer with every grouped member **deselected**
 * (the #1477 fix — no lingering multi-selection while the group mirrors back).
 * Returns `null` when there are fewer than two selected nodes (nothing to group).
 * @param flowNodes - The current render buffer.
 * @param selectedIds - Ids of the nodes to group (the current selection).
 * @returns The group-creation plan, or `null` when fewer than two nodes are selected.
 */
export function planGroupCreation(
  flowNodes: ReadonlyArray<Node>,
  selectedIds: ReadonlyArray<string>,
): GroupCreationPlan | null {
  if (selectedIds.length < 2) return null;
  const ids = new Set(selectedIds);
  const members = flowNodes.filter((node) => ids.has(node.id));
  const rect = computeGroupRect(members);
  const position = rect ? { x: rect.x, y: rect.y } : { x: 0, y: 0 };
  const nextNodes = flowNodes.map((node) =>
    ids.has(node.id) && node.selected ? { ...node, selected: false } : node,
  );
  return { childIds: [...selectedIds], position, nextNodes };
}
