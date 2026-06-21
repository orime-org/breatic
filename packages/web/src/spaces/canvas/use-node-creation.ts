// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import { addNode } from '@web/data/yjs/canvas-space';
import {
  cloneForPaste,
  textToNode,
  type ClipboardNode,
} from '@web/spaces/canvas/node-clipboard';
import {
  createEmptyNode,
  type CreatableNodeType,
} from '@web/spaces/canvas/node-factory';
import { useCurrentUserStore } from '@web/stores/current-user';

/**
 * Fixed offset a duplicated node is shifted from its source so the copy sits
 * just beside the original rather than fully covering it (matches the paste
 * offset; "复制副本" lands one nudge away).
 */
const DUPLICATE_OFFSET_PX = 24;

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
  /**
   * Create a media node already in `handling` state for an in-flight upload
   * and return its id. The caller fills the node's content once the upload
   * resolves (`setNodeContent`) or writes an error (`setNodeError`).
   */
  createUploadNodeAt: (
    type: CreatableNodeType,
    position: { x: number; y: number },
  ) => string;
  /**
   * Paste plain text as a new text node at a position; returns its id.
   * The pasted text becomes the node's content.
   */
  pasteTextAt: (text: string, position: { x: number; y: number }) => string;
  /**
   * Paste cloned clipboard nodes (fresh ids, positions shifted by `offset`
   * so relative layout is preserved); returns the new node ids in order.
   */
  pasteNodesAt: (
    nodes: ReadonlyArray<ClipboardNode>,
    offset: { dx: number; dy: number },
  ) => string[];
  /**
   * Duplicate the given nodes in place ("复制副本"): clone them at a fixed
   * {@link DUPLICATE_OFFSET_PX} nudge and write them straight to Yjs, never
   * touching the system clipboard (that is the distinct copy path). Shared by
   * the single-node and multi-selection right-click menus; returns the new ids.
   */
  duplicateNodes: (nodes: ReadonlyArray<ClipboardNode>) => string[];
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
  const createUploadNodeAt = React.useCallback(
    (type: CreatableNodeType, position: { x: number; y: number }): string => {
      const node = createEmptyNode(type, position, userId, 'handling');
      addNode(projectId, spaceId, node);
      return node.id;
    },
    [projectId, spaceId, userId],
  );
  const pasteTextAt = React.useCallback(
    (text: string, position: { x: number; y: number }): string => {
      const node = textToNode(text, position, userId);
      addNode(projectId, spaceId, node);
      return node.id;
    },
    [projectId, spaceId, userId],
  );
  const pasteNodesAt = React.useCallback(
    (
      nodes: ReadonlyArray<ClipboardNode>,
      offset: { dx: number; dy: number },
    ): string[] => {
      const cloned = cloneForPaste(nodes, userId, offset);
      cloned.forEach((node) => addNode(projectId, spaceId, node));
      return cloned.map((node) => node.id);
    },
    [projectId, spaceId, userId],
  );
  const duplicateNodes = React.useCallback(
    (nodes: ReadonlyArray<ClipboardNode>): string[] =>
      pasteNodesAt(nodes, { dx: DUPLICATE_OFFSET_PX, dy: DUPLICATE_OFFSET_PX }),
    [pasteNodesAt],
  );
  return {
    createNodeAt,
    createUploadNodeAt,
    pasteTextAt,
    pasteNodesAt,
    duplicateNodes,
  };
}
