// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import { addNode } from '@web/data/yjs/canvas-space';
import {
  createEmptyNode,
  type CreatableNodeType,
} from '@web/spaces/canvas/node-factory';
import { useCurrentUserStore } from '@web/stores/current-user';

export interface NodeCreation {
  /**
   * Create an empty node of `type` at a canvas position and return its id.
   * The caller (canvas) supplies the already-resolved flow-coordinate drop
   * point (viewport centre for the library, cursor for right-click).
   */
  createNodeAt: (
    type: CreatableNodeType,
    position: { x: number; y: number },
  ) => string;
}

/**
 * Canvas node-creation core — composes the empty-node factory with the
 * frontend-owned Yjs `addNode` write. Kept as a hook (not inline in the
 * canvas) so the create path stays unit-testable without mounting ReactFlow:
 * the `createdBy` is read here from the current-user store, the only piece
 * the pure factory cannot supply.
 * @param projectId - Owning project id.
 * @param spaceId - Canvas space id.
 * @returns The `createNodeAt` action bound to this project / space.
 */
export function useNodeCreation(
  projectId: string,
  spaceId: string,
): NodeCreation {
  const userId = useCurrentUserStore((s) => s.user?.id) ?? '';
  const createNodeAt = React.useCallback(
    (type: CreatableNodeType, position: { x: number; y: number }): string => {
      const node = createEmptyNode(type, position, userId);
      addNode(projectId, spaceId, node);
      return node.id;
    },
    [projectId, spaceId, userId],
  );
  return { createNodeAt };
}
