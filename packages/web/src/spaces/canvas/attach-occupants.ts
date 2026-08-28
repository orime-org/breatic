// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Node } from '@xyflow/react';

/** The key the occupant list travels under inside a node's `data`. */
const OCCUPANTS_KEY = 'occupants';

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
  const held = (data as Record<string, unknown> | null)?.[OCCUPANTS_KEY];
  return (held as readonly string[] | undefined) ?? null;
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
