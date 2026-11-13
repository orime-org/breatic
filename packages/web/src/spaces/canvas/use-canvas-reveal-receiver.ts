// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';

import { useCanvasRevealStore } from '@web/stores/canvas-reveal';

/**
 * Take up a "View" press for this canvas (#1411 design 5.4) once it has
 * loaded and the node has arrived, and show the node.
 * @param spaceId - This canvas.
 * @param ready - Whether the canvas has loaded.
 * @param hasNode - Whether a node is on the canvas now; a new function whenever the nodes change.
 * @param reveal - Moves the view to the node and selects it.
 */
export function useCanvasRevealReceiver(
  spaceId: string,
  ready: boolean,
  hasNode: (nodeId: string) => boolean,
  reveal: (nodeId: string) => void,
): void {
  const request = useCanvasRevealStore((s) => s.request);
  React.useEffect(() => {
    if (!ready || request?.spaceId !== spaceId || !hasNode(request.nodeId)) return;
    const nodeId = useCanvasRevealStore.getState().take(spaceId);
    if (nodeId !== null) reveal(nodeId);
  }, [ready, request, spaceId, hasNode, reveal]);
}
