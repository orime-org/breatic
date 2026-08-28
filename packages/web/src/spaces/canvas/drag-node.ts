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

import type { Node } from '@xyflow/react';

import type { Point } from '@web/spaces/canvas/group-geometry';
import { toAbsolutePosition } from '@web/spaces/canvas/group-geometry';
import type { DragNode, GroupDragOps } from '@web/spaces/canvas/group-drag';
import { planGroupDrag } from '@web/spaces/canvas/group-drag';
import { EMPTY_NODE_SIZE } from '@web/spaces/canvas/node-factory';

/**
 * Everything but the position, which is what the two frames disagree about.
 *
 * An unmeasured node is sized at the size a node is created at, which every
 * other geometry path in the canvas also falls back to. The number decides
 * where a node's centre is, and the centre decides which Group it belongs to,
 * so a guess of its own here would answer that question differently from the
 * paths running in the same frame.
 * @param item - The node.
 * @param absPos - Its absolute position in the chosen frame.
 * @returns The planner's form of it.
 */
function withPlace(item: Node, absPos: Point): DragNode {
  return {
    id: item.id,
    type: item.type ?? '',
    parentId: item.parentId,
    absPos,
    size: {
      width: item.measured?.width ?? item.width ?? EMPTY_NODE_SIZE.width,
      height: item.measured?.height ?? item.height ?? EMPTY_NODE_SIZE.height,
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
  item: Node,
  within: ReadonlyMap<string, Node>,
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
  item: Node,
  onScreen: ReadonlyMap<string, Node>,
  paintedAt: Point | undefined,
): DragNode {
  return paintedAt === undefined
    ? toPlacedDragNode(item, onScreen)
    : withPlace(item, paintedAt);
}

/** The two views of the render buffer a drag-stop decides between. */
export interface DragStopViews {
  /** The nodes this drag is moving, as the render buffer has them. */
  dragged: ReadonlyArray<Node>;
  /** The whole render buffer, in-flight geometry included. */
  onScreen: ReadonlyArray<Node>;
  /** The same buffer with every remote gesture back at its document place. */
  settled: ReadonlyArray<Node>;
  /** The ids remote gestures are holding. */
  heldByRemote: ReadonlySet<string>;
  /** The Groups a remote is resizing, out of those it holds. */
  resizedByRemote: ReadonlySet<string>;
  /**
   * Where ReactFlow says a node's absolute position is.
   * @param id - The node's id.
   * @returns The point, or undefined when ReactFlow has no answer.
   */
  paintedAt: (id: string) => Point | undefined;
}

/**
 * What one drag-stop writes, with each planner argument read in its own frame.
 *
 * Which view feeds which argument is the whole decision, and it lived in the
 * canvas component where nothing could test it — the same two arguments were
 * handed the same frame twice before, and both times the suite stayed green.
 * It is one function here so a test can hand it two frames that disagree.
 * @param views - The buffer as this screen draws it and as the document has it.
 * @returns The reparents, positions and expansions to commit.
 */
export function planDragStop(views: DragStopViews): GroupDragOps {
  const onScreenById = new Map(views.onScreen.map((item) => [item.id, item]));
  const settledById = new Map(views.settled.map((item) => [item.id, item]));
  /**
   * Where this screen is drawing a node, which is the point the pointer was over.
   * @param item - The render-buffer node.
   * @returns The node in the planner's absolute form.
   */
  const toScreen = (item: Node): DragNode =>
    toScreenDragNode(item, onScreenById, views.paintedAt(item.id));
  /**
   * Where the document has a node, whatever any screen is showing.
   * @param item - The settled node.
   * @returns The node in the planner's absolute form.
   */
  const toDocument = (item: Node): DragNode =>
    toPlacedDragNode(item, settledById);
  return planGroupDrag(
    views.dragged.map(toScreen),
    views.onScreen.map(toScreen),
    views.heldByRemote,
    views.settled.map(toDocument),
    views.resizedByRemote,
  );
}
