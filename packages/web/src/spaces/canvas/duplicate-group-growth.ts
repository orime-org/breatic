// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Node } from '@xyflow/react';

import {
  EMPTY_NODE_SIZE,
  planGroupGrowth,
  type GroupGrowth,
  type GroupGrowthInput,
  type Rect,
} from '@web/spaces/canvas/group-geometry';

/**
 * The Group growth needed when a duplicate drops clones into EXISTING Groups
 * (R2-A): a clone offset +24 from a source at the Group's edge can sit flush
 * against the border, so each affected Group expands to keep `GROUP_PADDING`.
 * Builds every affected Group's full member set (current members + the new
 * clones) in absolute coordinates — a clone's size is its source's measured size
 * (it is an exact copy, found through `sourceOf`) — then defers the
 * only-up growth math to {@link planGroupGrowth}.
 * @param sourceOf - Clone id → the id of the node it copies, whose size it has.
 * @param clones - The freshly written clones (parentId + parent-relative position).
 * @param ext - Existing Groups (outside the payload) that gained members → their absolute top-left.
 * @param allNodes - All current flow nodes (existing members + Group rects + source sizes).
 * @returns One growth per existing Group whose size must increase.
 */
export function planDuplicateGroupGrowth(
  sourceOf: ReadonlyMap<string, string>,
  clones: ReadonlyArray<{ id: string; parentId?: string; position: { x: number; y: number } }>,
  ext: ReadonlyMap<string, { x: number; y: number }>,
  allNodes: ReadonlyArray<Node>,
): GroupGrowth[] {
  if (ext.size === 0) return [];
  const byId = new Map(allNodes.map((node) => [node.id, node]));
  /**
   * A node's rendered size (measured first, then stored, then the drag fallback).
   * @param node - The flow node, or undefined when not found.
   * @returns Its width / height.
   */
  const sizeOf = (node: Node | undefined): { width: number; height: number } => ({
    width: node?.measured?.width ?? node?.width ?? EMPTY_NODE_SIZE.width,
    height: node?.measured?.height ?? node?.height ?? EMPTY_NODE_SIZE.height,
  });
  const inputs: GroupGrowthInput[] = [];
  for (const [groupId, groupAbs] of ext) {
    const groupNode = byId.get(groupId);
    if (groupNode === undefined) continue;
    const memberRects: Rect[] = [];
    for (const node of allNodes) {
      if (node.parentId !== groupId) continue;
      const size = sizeOf(node);
      memberRects.push({
        x: groupAbs.x + node.position.x,
        y: groupAbs.y + node.position.y,
        width: size.width,
        height: size.height,
      });
    }
    clones.forEach((clone) => {
      if (clone.parentId !== groupId) return;
      const size = sizeOf(byId.get(sourceOf.get(clone.id) ?? ''));
      memberRects.push({
        x: groupAbs.x + clone.position.x,
        y: groupAbs.y + clone.position.y,
        width: size.width,
        height: size.height,
      });
    });
    inputs.push({
      groupId,
      rect: {
        x: groupNode.position.x,
        y: groupNode.position.y,
        width: groupNode.width ?? groupNode.measured?.width ?? EMPTY_NODE_SIZE.width,
        height:
          groupNode.height ?? groupNode.measured?.height ?? EMPTY_NODE_SIZE.height,
      },
      memberRects,
    });
  }
  return planGroupGrowth(inputs);
}
