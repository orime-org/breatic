// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { Node } from '@xyflow/react';

/**
 * Merge local selection state into a freshly mirrored node array. Yjs is the
 * source of truth for node data / position, but **selection (and an in-flight
 * drag) is per-user local UI state** that does not live in Yjs. The mirror
 * rebuilds the whole ReactFlow node array from Yjs on every doc change, so
 * without this merge a collaborator / backend write to any node would wipe the
 * current user's selection (including the just-created node's auto-selection).
 *
 * Selection / drag flags are carried forward by id; everything else (data,
 * position) comes from the fresh nodes. Brand-new nodes (not in `prev`) are
 * left as-is — the auto-select effect selects a freshly created node
 * explicitly once it appears.
 * @param prev - The previous render buffer (holds local selection / drag).
 * @param fresh - The nodes freshly mapped from the Yjs mirror.
 * @returns The fresh nodes with local selection / drag flags preserved by id.
 */
export function mergeMirroredSelection(
  prev: ReadonlyArray<Node>,
  fresh: ReadonlyArray<Node>,
): Node[] {
  const local = new Map(
    prev.map((node) => [
      node.id,
      { selected: node.selected, dragging: node.dragging },
    ]),
  );
  return fresh.map((node) => {
    const carried = local.get(node.id);
    return carried ? { ...node, ...carried } : node;
  });
}
