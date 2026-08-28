// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Node } from '@xyflow/react';

import { attachOccupants } from '@web/spaces/canvas/attach-occupants';
import type { GestureGeometry, GestureTable } from '@web/spaces/canvas/gesture-table';
import { speaksFor } from '@web/spaces/canvas/gesture-table';
import { sameData, sameRenderInputs } from '@web/spaces/canvas/mirror-selection';

/** The three inputs the merge arbitrates between, besides the document. */
export interface MergeInput {
  /** Node id to the user ids holding it. */
  occupants: ReadonlyMap<string, readonly string[]>;
  /** Node id to the geometry a remote gesture is showing it at (absolute). */
  remoteGesture: GestureTable;
  /** The nodes this client's own gesture is moving. */
  localGestureIds: ReadonlySet<string>;
}

/** Where a node is drawn and how big it is, once the arbitration has run. */
interface ResolvedGeometry {
  /** Position, in the coordinate space ReactFlow expects for this node. */
  position: { x: number; y: number };
  /** Width, when this node carries one. */
  width?: number;
  /** Height, when this node carries one. */
  height?: number;
}


/**
 * Build the geometry a remote gesture is asking for, in the space ReactFlow
 * wants it: absolute on the wire, relative to the Group for a member.
 * @param node - The node as the document has it.
 * @param gesture - What the remote published for it.
 * @param groupOrigin - The Group's absolute position, or null for a top-level node.
 * @returns The geometry to draw at.
 */
function fromRemote(
  node: Node,
  gesture: GestureGeometry,
  groupOrigin: { x: number; y: number } | null,
): ResolvedGeometry {
  const position =
    groupOrigin === null
      ? { x: gesture.x, y: gesture.y }
      : { x: gesture.x - groupOrigin.x, y: gesture.y - groupOrigin.y };
  const width = gesture.width ?? node.width;
  const height = gesture.height ?? node.height;
  return { position, width, height };
}

/**
 * Decide where every node is drawn this pass, and rebuild the render buffer.
 *
 * One writer for the buffer, so the arbitration lives in one place: a node this
 * client is gesturing on keeps the geometry ReactFlow is giving it, a node a
 * remote is gesturing on takes that remote's geometry, and everything else
 * takes the document's. `LOCAL` beats `REMOTE` beats `DOC` — the user holding
 * a node always wins, and a live gesture is newer than what the document knows.
 * The three are worked out afresh on every pass rather than stored, so a node
 * whose local gesture ends while a remote still holds it lands on that remote.
 *
 * Local-only state is carried across the rebuild, because the document cannot
 * produce it: the selection, the drag and resize flags, and `measured` — the
 * size ReactFlow observed, which `toFlowNode` never emits and no document
 * geometry can restore.
 *
 * Reference stability both ways (#1647): a node whose render inputs held still
 * is handed back as the same object, and a buffer where nothing moved is handed
 * back as the same array.
 * @param prev - The previous render buffer, holding the local-only state.
 * @param fresh - The nodes freshly mapped from the Yjs mirror.
 * @param input - The occupants, the remote gestures, and this client's own.
 * @returns The buffer to render.
 */
export function mergeCanvasNodes(
  prev: ReadonlyArray<Node>,
  fresh: ReadonlyArray<Node>,
  input: MergeInput,
): Node[] {
  const { occupants, remoteGesture, localGestureIds } = input;
  const prevById = new Map(prev.map((node) => [node.id, node]));
  const freshById = new Map(fresh.map((node) => [node.id, node]));

  /**
   * Where a Group's origin sits this pass, which is what a member's relative
   * position is measured from. Group nesting is forbidden
   * (`group-topology.ts`), so this never recurses.
   * @param groupId - The parent Group's id.
   * @returns Its absolute position, or null when the buffer has no such Group.
   */
  const groupOrigin = (groupId: string): { x: number; y: number } | null => {
    const held = prevById.get(groupId);
    if (localGestureIds.has(groupId) && held !== undefined) return held.position;
    const gesture = remoteGesture.get(groupId);
    if (gesture !== undefined) return { x: gesture.x, y: gesture.y };
    return freshById.get(groupId)?.position ?? held?.position ?? null;
  };

  /**
   * Run the arbitration for one node.
   * @param node - The node as the document has it.
   * @param held - The same node in the previous buffer, when it was there.
   * @returns The geometry to draw at, or null to keep the document's.
   */
  const resolve = (node: Node, held: Node | undefined): ResolvedGeometry | null => {
    if (localGestureIds.has(node.id)) {
      // The held position was measured against the parent the node had at the
      // time. A collaborator moving it between a Group and the top level
      // changes which origin that number is relative to, so it stops meaning
      // anything and the document's own geometry is what is left.
      if (held === undefined || held.parentId !== node.parentId) return null;
      return { position: held.position, width: held.width, height: held.height };
    }
    const gesture = remoteGesture.get(node.id);
    if (gesture === undefined) return null;
    if (!speaksFor(gesture, node)) return null;
    if (node.parentId === undefined) return fromRemote(node, gesture, null);
    const origin = groupOrigin(node.parentId);
    // A member whose Group has not arrived has nothing to measure from, so it
    // stays where the document put it until the Group turns up.
    return origin === null ? null : fromRemote(node, gesture, origin);
  };

  let changed = false;
  const next = fresh.map((node) => {
    const held = prevById.get(node.id);
    const geometry = resolve(node, held);
    const merged: Node = {
      ...node,
      ...(geometry === null ? {} : geometry),
      ...(held === undefined
        ? {}
        : {
          selected: held.selected,
          dragging: held.dragging,
          resizing: held.resizing,
          measured: held.measured,
        }),
    };
    const withHolders = attachOccupants(merged, occupants);
    if (held !== undefined && sameRenderInputs(held, withHolders, sameData)) return held;
    changed = true;
    return withHolders;
  });
  return changed || next.length !== prev.length ? next : (prev as Node[]);
}
