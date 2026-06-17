// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

/**
 * Canvas mutations a node body can trigger but cannot perform itself: the
 * node component knows *what* changed, only the canvas container holds the
 * `projectId` / `spaceId` needed to write it back to Yjs. Provided by
 * `CanvasSpaceInner` and consumed through the ReactFlow node wrapper, which
 * is the one layer that knows each node's id.
 */
export interface CanvasActions {
  /**
   * Persist a node's new display name to the Yjs doc (frontend-owned write,
   * same pattern as node position / deletion).
   */
  renameNode: (nodeId: string, name: string) => void;
  /**
   * Delete an edge from the Yjs doc (frontend-owned write). Bound to the
   * scissors affordance on a selected edge; a no-op for read-only viewers.
   */
  deleteEdge: (edgeId: string) => void;
}

/**
 * Default no-op actions so a node / edge rendered outside a provider
 * (defensive / isolated tests) never crashes; the real implementation is
 * always injected by `CanvasSpaceInner` in production.
 */
const NOOP_ACTIONS: CanvasActions = {
  renameNode: () => undefined,
  deleteEdge: () => undefined,
};

export const CanvasActionsContext =
  React.createContext<CanvasActions>(NOOP_ACTIONS);

/**
 * Read the canvas mutation handlers (rename, …) from context. The ReactFlow
 * node wrapper binds each handler to its own node id before handing it to
 * the body.
 * @returns The canvas actions provided by the surrounding canvas container.
 */
export function useCanvasActions(): CanvasActions {
  return React.useContext(CanvasActionsContext);
}
