// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Node } from '@xyflow/react';

import { sameIdList } from '@web/spaces/canvas/active-node-ids';

/** The key the occupant list travels under inside a node's `data`. */
export const OCCUPANTS_KEY = 'occupants';

/**
 * Read the holders out of a node's `data`, if it carries any.
 *
 * The one place that knows the key's shape, so a rename stays a rename: every
 * reader goes through here, including the node renderer that receives `data`
 * from ReactFlow rather than a whole node.
 * @param data - A render-buffer node's data record.
 * @returns The user ids holding it, or null when it carries none.
 */
export function readOccupants(data: unknown): readonly string[] | null {
  return (data as { occupants?: readonly string[] } | null)?.occupants ?? null;
}

/**
 * Carry who is holding a node into the node itself.
 *
 * The list rides in `data` because that is the one channel a node body can
 * read: `ContentNodeFrameProps` is a fixed set of named parameters and the six
 * modality components build their calls literally, so nothing else reaches
 * them without every one of those files forwarding it.
 *
 * A node nobody holds is handed back **as the same object**. Almost every node
 * on a canvas is in that branch, and reference identity is what lets the
 * mirror reuse the previous node and `React.memo` bail — a fresh object per
 * node would re-render the whole canvas on every remote selection change.
 * @param node - The freshly mirrored flow node.
 * @param byNode - Node id to the user ids holding it.
 * @returns The node, carrying its holders when it has any.
 */
export function attachOccupants(
  node: Node,
  byNode: ReadonlyMap<string, readonly string[]>,
): Node {
  const holders = byNode.get(node.id);
  if (holders === undefined) return node;
  return { ...node, data: { ...node.data, [OCCUPANTS_KEY]: holders } };
}

/**
 * Take a node's holders back off it.
 * @param node - A node carrying holders.
 * @returns The node without the key.
 */
function withoutOccupants(node: Node): Node {
  const { [OCCUPANTS_KEY]: _dropped, ...rest } = node.data as Record<
    string,
    unknown
  >;
  return { ...node, data: rest };
}

/**
 * Bring a whole render buffer in line with a fresh occupant table.
 *
 * This is the path a change of holders takes on its own, with no Yjs write
 * behind it — someone else selecting a node, or letting one go. It rewrites
 * `data` and touches nothing else, which is the point: the mirror takes its
 * positions from Yjs, and a drag in progress has moved the node somewhere Yjs
 * has not heard about yet. Measured on a real canvas: running the whole mirror
 * for a remote selection put the dragged node back at its starting position
 * until the next pointer event moved it out again.
 *
 * A node whose holders are unchanged keeps its object reference, and a buffer
 * where nothing changed is handed back as the same array, so `React.memo`
 * bails everywhere but the nodes that really changed hands.
 * @param nodes - The current render buffer.
 * @param byNode - Node id to the user ids holding it.
 * @returns The buffer with every node's holders current.
 */
export function applyOccupants(
  nodes: ReadonlyArray<Node>,
  byNode: ReadonlyMap<string, readonly string[]>,
): Node[] {
  let changed = false;
  const next = nodes.map((node) => {
    const holders = byNode.get(node.id) ?? null;
    if (sameIdList(readOccupants(node.data), holders)) return node;
    changed = true;
    return holders === null
      ? withoutOccupants(node)
      : attachOccupants(node, byNode);
  });
  return changed ? next : (nodes as Node[]);
}
