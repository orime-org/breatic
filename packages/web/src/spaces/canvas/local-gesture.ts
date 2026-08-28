// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { GestureBatch } from '@web/spaces/canvas/gesture-table';

/** What this module needs off a render-buffer node to place it. */
export interface GeometryNode {
  /** The node's id. */
  id: string;
  /** Containing Group id, when this node is a member. */
  parentId?: string;
  /** Position — relative to the parent Group for a member, absolute otherwise. */
  position: { x: number; y: number };
  /** Stored width, which only a Group carries. */
  width?: number;
  /** Stored height, which only a Group carries. */
  height?: number;
}

/**
 * The nodes one gesture is moving, each with the node that brought it in.
 *
 * Dragging or resizing a Group moves every member with it — ReactFlow rewrites
 * each member's relative position as the Group's origin moves — so a Group in
 * the seed pulls its members in. Group nesting is forbidden
 * (`group-topology.ts`), so one pass is the whole depth.
 *
 * The pairing is settled here, once, along with the membership: a member that
 * leaves the Group while the gesture runs stays in the batch, and its entry has
 * to keep naming the Group for a reader to tell it apart from an entry for a
 * node the gesture has hold of directly. A node in the seed speaks for itself
 * even when it is also somebody's member.
 * @param seedIds - What the gesture has hold of: the dragged nodes, or the resized Group.
 * @param allNodes - The whole render buffer, which is where membership is read.
 * @returns Each node id this gesture decides, mapped to what brought it in.
 */
export function gestureRoots(
  seedIds: ReadonlyArray<string>,
  allNodes: ReadonlyArray<GeometryNode>,
): Map<string, string> {
  const roots = new Map(seedIds.map((id) => [id, id]));
  for (const node of allNodes) {
    if (
      node.parentId !== undefined &&
      roots.has(node.parentId) &&
      !roots.has(node.id)
    ) {
      roots.set(node.id, node.parentId);
    }
  }
  return roots;
}

/**
 * The absolute geometry to publish for the nodes a gesture is moving.
 *
 * Absolute, because the reader cannot be assumed to agree about who is inside
 * which Group yet. A size rides along only for the Group being resized: a drag
 * changes nothing's size, and a member inside a resize only moves.
 * @param roots - The gesture's nodes and what brought each in, from {@link gestureRoots}.
 * @param allNodes - The render buffer the geometry is read out of.
 * @param resizedGroupId - The Group being resized, or null during a drag.
 * @returns Node id to absolute geometry, ready for the wire.
 */
export function gestureGeometry(
  roots: ReadonlyMap<string, string>,
  allNodes: ReadonlyArray<GeometryNode>,
  resizedGroupId: string | null,
): GestureBatch {
  const byId = new Map(allNodes.map((node) => [node.id, node]));
  const published: GestureBatch = {};
  for (const [id, root] of roots) {
    const node = byId.get(id);
    if (node === undefined) continue;
    let { x, y } = node.position;
    if (node.parentId !== undefined) {
      const parent = byId.get(node.parentId);
      // A member with no Group to measure from has no absolute place to
      // publish. Group nesting is forbidden, so the parent's own position is
      // already absolute.
      if (parent === undefined) continue;
      x += parent.position.x;
      y += parent.position.y;
    }
    published[id] =
      id === resizedGroupId && node.width !== undefined && node.height !== undefined
        ? { x, y, width: node.width, height: node.height, root }
        : { x, y, root };
  }
  return published;
}
