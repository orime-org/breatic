// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { CanvasNodeFields, NodeState } from '@breatic/shared';
import { newId } from '@breatic/shared';

import { MODALITY_LABEL } from '@web/spaces/canvas/nodes/_shared/modality';

/** The 4 content modalities a user can create as an empty node. */
export type CreatableNodeType = 'text' | 'image' | 'audio' | 'video';

/**
 * The fixed footprint of an empty / handling content node — the empty-state box
 * (`NodeContent`: 288 × 192). Used to place a new node CENTERED on a drop point
 * (its top-left = point − size/2) so it appears centred where the user dropped
 * it, not offset to the bottom-right.
 */
export const EMPTY_NODE_SIZE = { width: 288, height: 192 } as const;

/**
 * Convert a desired CENTER point into the node's top-left, given the node's
 * size — so a node dropped "at a point" is centred on it rather than having its
 * top-left there.
 * @param center - The point the node should be centred on.
 * @param center.x - The center X.
 * @param center.y - The center Y.
 * @param size - The node's footprint.
 * @param size.width - The node width.
 * @param size.height - The node height.
 * @returns The top-left position to store on the node.
 */
export function centerToTopLeft(
  center: { x: number; y: number },
  size: { width: number; height: number },
): { x: number; y: number } {
  return { x: center.x - size.width / 2, y: center.y - size.height / 2 };
}

/**
 * The creatable modalities in menu order — the single source of truth for
 * the node-library dropdown and the canvas right-click menu. 3d / web exist
 * as modalities but are not offered as creation entries yet; annotation /
 * group are not content nodes.
 */
export const CREATABLE_NODE_TYPES: readonly CreatableNodeType[] = [
  'text',
  'image',
  'audio',
  'video',
];

/**
 * Type guard narrowing an arbitrary node-type string to a creatable one —
 * used by the canvas to validate a create intent read from the (broadly
 * typed) chrome → canvas mailbox before building the node.
 * @param type - The candidate node-type string.
 * @returns True when `type` is one of the 4 creatable content modalities.
 */
export function isCreatableNodeType(type: string): type is CreatableNodeType {
  return (CREATABLE_NODE_TYPES as readonly string[]).includes(type);
}

/**
 * Builds a fresh empty content node in the shared wire shape. Pure function:
 * `createdBy` is injected by the caller (read from the current-user store) so
 * the factory stays free of React / store access and is trivially testable.
 * Only the always-present fields are set; content / coverUrl / Generate
 * inputs stay absent until the node is filled.
 *
 * `initialState` defaults to `idle`; an upload entry passes `handling` so the
 * node is created already in the uploading state — written to Yjs in a single
 * `addNode` so collaborators see it as `handling` immediately (no idle flash).
 * @param type - The content modality to create (text / image / audio / video).
 * @param position - Canvas coordinates the node is placed at.
 * @param position.x - X coordinate.
 * @param position.y - Y coordinate.
 * @param createdBy - User id of the creator (caller injects from the store).
 * @param initialState - Initial node state (`idle` default; `handling` for an
 *   upload node that fills its content asynchronously).
 * @returns A complete {@link CanvasNodeFields} for an empty content node.
 */
export function createEmptyNode(
  type: CreatableNodeType,
  position: { x: number; y: number },
  createdBy: string,
  initialState: NodeState = 'idle',
): CanvasNodeFields {
  return {
    id: newId(),
    type,
    position,
    data: {
      name: MODALITY_LABEL[type],
      createdAt: Date.now(),
      createdBy,
      locked: false,
      operationLocks: [],
      state: initialState,
      attachments: [],
      // A handling upload node carries its driver + lease start (#1569):
      // disconnect-cleanup matches on handlingBy (userId + type='frontend')
      // and the collab sweeper measures HANDLING_TIMEOUT_MS from startedAt.
      // Creating handling WITHOUT handlingBy is exactly the bug that left
      // upload nodes stuck in handling forever after a crashed tab.
      ...(initialState === 'handling'
        ? {
          handlingBy: {
            userId: createdBy,
            type: 'frontend' as const,
            startedAt: Date.now(),
          },
        }
        : {}),
    },
  };
}

/** Fixed-English default name for a new Group — a data value, not a localized label. */
const GROUP_DEFAULT_NAME = 'Group';

/**
 * Builds a fresh Group node (group redesign 2026-06-23) in the shared wire
 * shape. A Group stores its own authoritative `width`/`height` (manual resize)
 * and holds no `childIds` — members bind back via their own top-level
 * `parentId`. Pure (like the other factories): the caller injects the
 * id (pre-generated so the same id seeds the creation plan) and `createdBy`.
 * @param id - Pre-generated id for the Group (shared with the creation plan).
 * @param position - The Group's stored top-left in canvas coordinates.
 * @param position.x - X coordinate.
 * @param position.y - Y coordinate.
 * @param width - The Group's authoritative width.
 * @param height - The Group's authoritative height.
 * @param createdBy - User id of the creator (caller injects from the store).
 * @returns A complete {@link CanvasNodeFields} for a Group node.
 */
export function createGroupNode(
  id: string,
  position: { x: number; y: number },
  width: number,
  height: number,
  createdBy: string,
): CanvasNodeFields {
  return {
    id,
    type: 'group',
    position,
    data: {
      name: GROUP_DEFAULT_NAME,
      createdAt: Date.now(),
      createdBy,
      locked: false,
      operationLocks: [],
      state: 'idle',
      attachments: [],
      width,
      height,
    },
  };
}
