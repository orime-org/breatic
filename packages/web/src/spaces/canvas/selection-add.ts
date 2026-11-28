// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The selection plus (inner#2216): which selection shows a plus at its right
 * edge, which nodes a pick wires into the new node, where that node lands,
 * and when a lone selected node shows the plus on its own handles instead.
 *
 * Kept free of React and xyflow so the rules are unit-tested on their own;
 * the canvas maps its nodes to {@link SelectionAddNode} at the call site.
 */

import type { NodePlacement } from '@web/data/yjs/canvas-space';
import { EMPTY_NODE_SIZE, groupRectForMembers, type Rect } from '@web/spaces/canvas/group-geometry';
import { canConnect } from '@web/spaces/canvas/lib/connection-rules';
import {
  LAYER_STEP_PX,
  ROW_GAP_PX,
  occupiedRects,
  shiftRightPastOccupied,
  withTaskCounts,
} from '@web/spaces/canvas/lib/place-flow';
import type { CreatableNodeType } from '@web/spaces/canvas/node-factory';

/** The node facts the selection plus reads. */
export interface SelectionAddNode {
  id: string;
  type: string;
  /** The group holding the node, when it is a member. */
  parentId?: string;
  /** The node's absolute flow position. */
  position: { x: number; y: number };
  width: number;
  height: number;
}

/** How far outside the selection's right edge the plus sits, in screen px. */
export const SELECTION_ADD_OFFSET_PX = 16;

/** One preview wire, in flow coordinates. */
export interface PreviewWire {
  sourceId: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
}

/** The node facts that decide the offer, without geometry. */
export type SelectionAddKind = Pick<SelectionAddNode, 'id' | 'type' | 'parentId'>;

/** What the current selection offers. */
export type SelectionAdd =
  | { kind: 'none' }
  | { kind: 'single'; nodeId: string }
  | { kind: 'add'; anchorIds: string[]; sourceIds: string[] };

/** What one pick from the plus menu builds. */
export type ConnectedNodePlan =
  | { kind: 'full'; cap: number }
  | { kind: 'ok'; center: { x: number; y: number }; sourceIds: string[] };

/**
 * Whether a node takes edges: notes are remarks and groups are containers,
 * neither is an edge endpoint (the same split as the handles in
 * `flow-node-types.tsx`).
 * @param type - The node's type.
 * @returns Whether it can be wired.
 * @throws {never} Never.
 */
function takesEdges(type: string): boolean {
  return type !== 'annotation' && type !== 'group';
}

/**
 * Decides what the selection offers. Notes are dropped first, as
 * `computeGroupToolbar` does: a note is selectable but never wired, so it
 * neither counts nor takes the plus away. What is left decides: one group
 * gets the plus and wires its members; one other node shows the plus on its
 * own handles; two or more get the plus around them and wire every content
 * node among them plus the members of any group among them.
 * @param selectedIds - The selected node ids.
 * @param nodes - Every node on the canvas.
 * @returns The offer.
 * @throws {never} Never.
 */
export function resolveSelectionAdd(
  selectedIds: readonly string[],
  nodes: readonly SelectionAddKind[],
): SelectionAdd {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const picked = selectedIds
    .map((id) => byId.get(id))
    .filter((node): node is SelectionAddKind => node !== undefined && node.type !== 'annotation');
  if (picked.length === 0) return { kind: 'none' };
  if (picked.length === 1 && picked[0].type !== 'group') return { kind: 'single', nodeId: picked[0].id };
  const groupIds = new Set(picked.filter((node) => node.type === 'group').map((node) => node.id));
  const sourceIds = new Set<string>();
  for (const node of picked) if (takesEdges(node.type)) sourceIds.add(node.id);
  for (const node of nodes) {
    if (node.parentId !== undefined && groupIds.has(node.parentId) && takesEdges(node.type)) sourceIds.add(node.id);
  }
  return { kind: 'add', anchorIds: picked.map((node) => node.id), sourceIds: [...sourceIds] };
}

/**
 * Reference order: top to bottom, then left to right.
 * @param nodes - The nodes to order.
 * @returns A sorted copy.
 * @throws {never} Never.
 */
export function orderSources<T extends { position: { x: number; y: number } }>(nodes: readonly T[]): T[] {
  return [...nodes].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
}

/** The canvas library's node facts {@link placedNodes} reads. */
interface PlacedLike {
  type?: string;
  parentId?: string;
  internals: { positionAbsolute: { x: number; y: number } };
  measured: { width?: number; height?: number };
}

/**
 * The given nodes as the plan and the preview read them: absolute position
 * and measured size, skipping ids the canvas no longer holds.
 * @param ids - The node ids.
 * @param lookup - The canvas's node lookup.
 * @returns The nodes found, in the given order.
 * @throws {never} Never.
 */
export function placedNodes(
  ids: readonly string[],
  lookup: (id: string) => PlacedLike | undefined,
): SelectionAddNode[] {
  const nodes: SelectionAddNode[] = [];
  for (const id of ids) {
    const node = lookup(id);
    if (!node) continue;
    nodes.push({
      id,
      type: node.type ?? '',
      ...(node.parentId ? { parentId: node.parentId } : {}),
      position: node.internals.positionAbsolute,
      width: node.measured.width ?? 0,
      height: node.measured.height ?? 0,
    });
  }
  return nodes;
}

/**
 * The bounds around some nodes, the rect the plus sits beside.
 * @param nodes - The nodes.
 * @returns Their union rect, or null for none.
 * @throws {never} Never.
 */
export function boundsOf(nodes: readonly SelectionAddNode[]): Rect | null {
  return groupRectForMembers(
    nodes.map((node) => ({ ...node.position, width: node.width, height: node.height })),
    0,
  );
}

/**
 * The preview wires drawn while the plus menu is open: from each source's
 * right connection point to the plus button's left edge, which the toolbar
 * keeps {@link SELECTION_ADD_OFFSET_PX} screen px past the selection's right
 * edge at its vertical middle, whatever the zoom.
 * @param sources - The nodes a pick would wire in, in the order to draw.
 * @param bounds - The selection's bounds.
 * @param zoom - The canvas zoom.
 * @returns One wire per source.
 * @throws {never} Never.
 */
export function previewWires(sources: readonly SelectionAddNode[], bounds: Rect, zoom: number): PreviewWire[] {
  const to = { x: bounds.x + bounds.width + SELECTION_ADD_OFFSET_PX / zoom, y: bounds.y + bounds.height / 2 };
  return sources.map((source) => ({
    sourceId: source.id,
    from: { x: source.position.x + source.width, y: source.position.y + source.height / 2 },
    to,
  }));
}

/**
 * Plans one pick: the sources that connect into the picked type in reference
 * order, refused whole when they exceed the reference cap, and the new
 * node's centre one column right of the selection, level with its middle,
 * moved right past anything in the way. The selection itself is no obstacle:
 * every node carries its task counts 68 canvas px past its right edge, and
 * the 72px column clears that on its own.
 * @param input - What the pick sees.
 * @param input.type - The picked node type.
 * @param input.sources - The candidate upstream nodes.
 * @param input.selectionBounds - The selection's bounds.
 * @param input.selectionIds - The selected nodes and the members they wire.
 * @param input.placements - Every node on the canvas.
 * @param input.measuredOf - A node's measured size, when known.
 * @param input.cap - The reference pool cap, or null when unknown.
 * @returns The plan.
 * @throws {never} Never.
 */
export function planConnectedNode(input: {
  type: CreatableNodeType;
  sources: readonly SelectionAddNode[];
  selectionBounds: Rect;
  selectionIds: readonly string[];
  placements: readonly NodePlacement[];
  measuredOf: (id: string) => { width: number; height: number } | undefined;
  cap: number | null;
}): ConnectedNodePlan {
  const sourceIds = orderSources(input.sources)
    .filter((source) => canConnect(source.type, input.type))
    .map((source) => source.id);
  if (input.cap !== null && sourceIds.length > input.cap) return { kind: 'full', cap: input.cap };
  const bounds = input.selectionBounds;
  const rect = {
    x: bounds.x + bounds.width + (LAYER_STEP_PX - EMPTY_NODE_SIZE.width),
    y: bounds.y + bounds.height / 2 - EMPTY_NODE_SIZE.height / 2,
    ...EMPTY_NODE_SIZE,
  };
  const selected = new Set(input.selectionIds);
  const obstacles = occupiedRects(
    input.placements.filter((placement) => !selected.has(placement.id)),
    input.measuredOf,
  );
  const dx = shiftRightPastOccupied(withTaskCounts(rect), obstacles, ROW_GAP_PX);
  return {
    kind: 'ok',
    center: { x: rect.x + dx + rect.width / 2, y: rect.y + rect.height / 2 },
    sourceIds,
  };
}
