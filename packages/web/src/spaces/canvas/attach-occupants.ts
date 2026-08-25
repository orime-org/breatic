// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { Node } from '@xyflow/react';

/** The key the occupant list travels under inside a node's `data`. */
export const OCCUPANTS_KEY = 'occupants';

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
