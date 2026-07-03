// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import {
  addNode,
  getCanvasClientId,
  runCanvasUndoBatch,
  type LeaseToken,
} from '@web/data/yjs/canvas-space';
import {
  cloneForPaste,
  textToNode,
  type ClipboardNode,
} from '@web/spaces/canvas/node-clipboard';
import {
  centerToTopLeft,
  createEmptyNode,
  EMPTY_NODE_SIZE,
  type CreatableNodeType,
} from '@web/spaces/canvas/node-factory';
import { useCurrentUserStore } from '@web/stores/current-user';

export interface NodeCreation {
  /**
   * Create an empty node of `type` CENTRED on a canvas point and return its id.
   * The caller (canvas) supplies the drop point (viewport centre for the
   * library, cursor for right-click / drag-drop); the node is placed centred on
   * it (top-left = point − {@link EMPTY_NODE_SIZE}/2).
   */
  createNodeAt: (
    type: CreatableNodeType,
    position: { x: number; y: number },
  ) => string;
  /**
   * Create a media node already in `handling` state for an in-flight upload,
   * CENTRED on the drop point. Returns the node id AND its first lease token
   * (#1580 #7 — gen 1 + this connection's clientId + the creator): the caller
   * completes the upload through the leased write-backs
   * (`completeNodeHandling` / `failNodeHandling`), which verify ownership.
   */
  createUploadNodeAt: (
    type: CreatableNodeType,
    position: { x: number; y: number },
  ) => { nodeId: string; lease: LeaseToken };
  /**
   * Paste plain text as a new text node CENTRED on a point; returns its id.
   * The pasted text becomes the node's content.
   */
  pasteTextAt: (text: string, position: { x: number; y: number }) => string;
  /**
   * Paste cloned clipboard nodes (fresh ids, positions shifted by `offset`
   * so relative layout is preserved); returns the new node ids in order.
   * The duplicate path (which can re-home a clone into an existing Group +
   * grow it) is orchestrated by the canvas, not here.
   */
  pasteNodesAt: (
    nodes: ReadonlyArray<ClipboardNode>,
    offset: { dx: number; dy: number },
  ) => string[];
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
  // Every create drop centres the new node on the given point (its top-left =
  // point − EMPTY_NODE_SIZE/2) so it appears centred where the user dropped it,
  // not offset to the bottom-right. Consistent across the library (viewport
  // centre), right-click create, drag-drop, and text paste.
  const createNodeAt = React.useCallback(
    (type: CreatableNodeType, position: { x: number; y: number }): string => {
      const node = createEmptyNode(
        type,
        centerToTopLeft(position, EMPTY_NODE_SIZE),
        userId,
      );
      addNode(projectId, spaceId, node);
      return node.id;
    },
    [projectId, spaceId, userId],
  );
  const createUploadNodeAt = React.useCallback(
    (
      type: CreatableNodeType,
      position: { x: number; y: number },
    ): { nodeId: string; lease: LeaseToken } => {
      // #1580 #7: a created-handling node opens its first lease inline —
      // the factory stamps gen 1 + this doc connection's clientId, and the
      // matching token goes back to the caller for the leased write-backs.
      const clientId = getCanvasClientId(projectId, spaceId);
      const node = createEmptyNode(
        type,
        centerToTopLeft(position, EMPTY_NODE_SIZE),
        userId,
        'handling',
        clientId,
      );
      addNode(projectId, spaceId, node);
      return { nodeId: node.id, lease: { gen: 1, clientId, userId } };
    },
    [projectId, spaceId, userId],
  );
  const pasteTextAt = React.useCallback(
    (text: string, position: { x: number; y: number }): string => {
      const node = textToNode(
        text,
        centerToTopLeft(position, EMPTY_NODE_SIZE),
        userId,
      );
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
      // One paste is ONE undo entry — a group + its members (or a multi-node
      // selection) must undo as a unit, not node-by-node (mirrors the duplicate
      // path's batch).
      runCanvasUndoBatch(projectId, spaceId, () => {
        cloned.forEach((node) => addNode(projectId, spaceId, node));
      });
      return cloned.map((node) => node.id);
    },
    [projectId, spaceId, userId],
  );
  return {
    createNodeAt,
    createUploadNodeAt,
    pasteTextAt,
    pasteNodesAt,
  };
}
