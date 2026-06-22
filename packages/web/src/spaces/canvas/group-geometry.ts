// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Pure group geometry — a group node carries no authoritative size; its
 * container is **derived** from its members' bounding box (+ padding) at
 * render. Kept ReactFlow-agnostic so the bounds math is unit-tested in
 * isolation; the canvas applies {@link applyGroupGeometry} over the measured
 * flow nodes before handing them to ReactFlow.
 */

import type { CSSProperties } from 'react';

/** Padding (px) added around the members' bounding box on every side. */
export const GROUP_PADDING = 24;

/** Footprint assumed for a member that ReactFlow has not measured yet. */
const DEFAULT_NODE_WIDTH = 160;
const DEFAULT_NODE_HEIGHT = 96;

/** A bounding rectangle in canvas (flow) coordinates. */
export interface GroupRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A group container rect frozen at drag-start (#1478): the stable full box used
 * while a member is dragged, so both the dissolve hit-test and the render stop
 * reacting to the member's mid-drag position (no reflow, no false dissolve).
 */
export interface FrozenGroupRect {
  groupId: string;
  rect: GroupRect;
}

/** The minimal node geometry the group bounds need (ReactFlow-agnostic). */
export interface GeoNode {
  id: string;
  position: { x: number; y: number };
  /** ReactFlow's post-layout measured size (absent before first measure). */
  measured?: { width?: number | null; height?: number | null } | null;
  width?: number | null;
  height?: number | null;
  type?: string;
  data?: unknown;
  style?: CSSProperties;
}

/**
 * A member's rendered footprint, falling back to a default cell before
 * ReactFlow has measured it so a fresh group still wraps its members.
 * @param node - The member node.
 * @returns The member's width + height in flow units.
 */
function sizeOf(node: GeoNode): { width: number; height: number } {
  const width = node.measured?.width ?? node.width ?? DEFAULT_NODE_WIDTH;
  const height = node.measured?.height ?? node.height ?? DEFAULT_NODE_HEIGHT;
  return {
    width: width || DEFAULT_NODE_WIDTH,
    height: height || DEFAULT_NODE_HEIGHT,
  };
}

/**
 * Read a group node's member ids from its `data.childIds`, tolerating the
 * loosely-typed flow `data` bag.
 * @param node - The group node.
 * @returns The member ids (empty when absent / malformed).
 */
function childIdsOf(node: GeoNode): string[] {
  const data = node.data;
  if (data == null || typeof data !== 'object' || !('childIds' in data)) {
    return [];
  }
  const ids = (data as { childIds?: unknown }).childIds;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * The bounding rectangle (+ padding) wrapping the given member nodes, or
 * `null` when there are no members.
 * @param members - The member nodes contributing to the bounds.
 * @param padding - Padding added on every side (default {@link GROUP_PADDING}).
 * @returns The padded bounding rect, or `null` for an empty member list.
 */
export function computeGroupRect(
  members: ReadonlyArray<GeoNode>,
  padding: number = GROUP_PADDING,
): GroupRect | null {
  if (members.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const member of members) {
    const { width, height } = sizeOf(member);
    minX = Math.min(minX, member.position.x);
    minY = Math.min(minY, member.position.y);
    maxX = Math.max(maxX, member.position.x + width);
    maxY = Math.max(maxY, member.position.y + height);
  }
  return {
    x: minX - padding,
    y: minY - padding,
    width: maxX - minX + 2 * padding,
    height: maxY - minY + 2 * padding,
  };
}

/**
 * Re-size every group node to wrap its members: a group's `position` becomes
 * the padded bounds' top-left and its `style` width/height the bounds' size.
 * The **frozen** group (a member is being dragged) instead uses the drag-start
 * snapshot rect, so its border stays put while the member moves and only
 * reflows on drag-stop (#1478). Non-group nodes — and groups whose members
 * cannot be resolved (all missing, or only the self-reference) — are returned
 * untouched (same reference) so referential-equality checks downstream stay cheap.
 * @param nodes - All flow nodes (members must be measured for an exact fit).
 * @param frozen - The drag-start snapshot of the group whose member is being dragged, or null.
 * @returns The nodes with each group sized to its members (or the snapshot, when frozen).
 */
export function applyGroupGeometry<T extends GeoNode>(
  nodes: ReadonlyArray<T>,
  frozen: FrozenGroupRect | null = null,
): T[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return nodes.map((node) => {
    if (node.type !== 'group') return node;
    let rect: GroupRect | null;
    if (frozen && node.id === frozen.groupId) {
      rect = frozen.rect;
    } else {
      const members = childIdsOf(node)
        .filter((id) => id !== node.id)
        .map((id) => byId.get(id))
        .filter((member): member is T => member != null);
      rect = computeGroupRect(members);
    }
    if (!rect) return node;
    return {
      ...node,
      position: { x: rect.x, y: rect.y },
      style: { ...node.style, width: rect.width, height: rect.height },
    };
  });
}
