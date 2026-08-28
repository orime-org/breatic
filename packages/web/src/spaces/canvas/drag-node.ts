// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Turning a render-buffer node into the absolute form the drag planner takes.
 *
 * There are two frames of reference and they are not interchangeable. The
 * screen is where the user aimed: a Group a remote is dragging is drawn at an
 * origin the document has never had, and its members are drawn against that
 * origin. The document is where a value has to be measured from when the other
 * end will later subtract its own travel from it.
 *
 * One function serving both is what made the last two attempts at this no-ops:
 * whichever list it was handed, it answered off the same live store. Each frame
 * gets its own name, and each reads only what that name promises.
 */

import type { Point } from '@web/spaces/canvas/group-geometry';
import { toAbsolutePosition } from '@web/spaces/canvas/group-geometry';
import type { DragNode } from '@web/spaces/canvas/group-drag';

/** What either conversion needs off a node. */
export interface PlaceableNode {
  /** The node's id. */
  id: string;
  /** Its type, 'group' for a Group. */
  type?: string;
  /** Its Group, when it is a member. */
  parentId?: string;
  /** Relative to the Group for a member, absolute otherwise. */
  position: Point;
  /** Whatever else the planner reads off it. */
  data?: unknown;
  /** Measured size, when ReactFlow has observed one. */
  measured?: { width?: number; height?: number };
  /** Stored width. */
  width?: number;
  /** Stored height. */
  height?: number;
}

/** Fallback extent for a node ReactFlow has not measured yet. */
export const DRAG_FALLBACK_W = 288;
/** Fallback extent for a node ReactFlow has not measured yet. */
export const DRAG_FALLBACK_H = 200;

/**
 * Everything but the position, which is what the two frames disagree about.
 * @param item - The node.
 * @param absPos - Its absolute position in the chosen frame.
 * @returns The planner's form of it.
 */
function withPlace(item: PlaceableNode, absPos: Point): DragNode {
  return {
    id: item.id,
    type: item.type ?? '',
    parentId: item.parentId,
    absPos,
    size: {
      width: item.measured?.width ?? item.width ?? DRAG_FALLBACK_W,
      height: item.measured?.height ?? item.height ?? DRAG_FALLBACK_H,
    },
    locked: Boolean((item.data as { locked?: unknown } | undefined)?.locked),
  };
}

/**
 * Where a node sits in the frame the list is written in: a member's position
 * added to its Group's, both read out of that same list.
 *
 * Group nesting is forbidden (`group-topology.ts`), so a Group's own position
 * is already absolute and one step is the whole depth.
 * @param item - The node.
 * @param within - Every node of that same list, by id.
 * @returns The node in the planner's absolute form.
 */
export function toPlacedDragNode(
  item: PlaceableNode,
  within: ReadonlyMap<string, PlaceableNode>,
): DragNode {
  const parent =
    item.parentId !== undefined ? within.get(item.parentId) : undefined;
  return withPlace(
    item,
    parent === undefined
      ? item.position
      : toAbsolutePosition(item.position, parent.position),
  );
}

/**
 * Where a node is painted, which is the point the pointer was over.
 *
 * ReactFlow states this itself, off the same frame it drew, so a member's
 * offset and its Group's origin never come from two different frames. It has no
 * answer for a node it is not rendering, and the list is the fallback there.
 * @param item - The node.
 * @param onScreen - Every node of the render buffer, by id.
 * @param paintedAt - What ReactFlow says this node's absolute position is.
 * @returns The node in the planner's absolute form.
 */
export function toScreenDragNode(
  item: PlaceableNode,
  onScreen: ReadonlyMap<string, PlaceableNode>,
  paintedAt: Point | undefined,
): DragNode {
  return paintedAt === undefined
    ? toPlacedDragNode(item, onScreen)
    : withPlace(item, paintedAt);
}
