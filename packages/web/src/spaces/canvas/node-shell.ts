// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { canvasRootOf } from '@web/spaces/canvas/canvas-context';

/**
 * The ReactFlow wrapper element for a node id, or null when it is not mounted.
 *
 * Written once because several places need it -- handing focus back on the
 * way out of an editor or a rename, and attaching the Enter listener -- and it
 * encodes how ReactFlow stamps its wrappers. Two copies of that coupling would
 * be free to drift the day the selector or the id escaping has to change.
 * @param spaceId - The Space whose canvas holds the node.
 * @param nodeId - The node whose wrapper to find.
 * @returns The wrapper element, or null.
 */
export function nodeShell(spaceId: string, nodeId: string): HTMLElement | null {
  const shell = canvasRootOf(spaceId).querySelector(
    `.react-flow__node[data-id="${nodeId}"]`,
  );
  return shell instanceof HTMLElement ? shell : null;
}
