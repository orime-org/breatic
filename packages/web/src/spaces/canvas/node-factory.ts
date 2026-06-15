// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { CanvasNodeFields } from '@breatic/shared';
import { newId } from '@breatic/shared';

import { MODALITY_LABEL } from '@web/spaces/canvas/nodes/_shared/modality';

/** The 4 content modalities a user can create as an empty node. */
export type CreatableNodeType = 'text' | 'image' | 'audio' | 'video';

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
 * @param type - The content modality to create (text / image / audio / video).
 * @param position - Canvas coordinates the node is placed at.
 * @param position.x - X coordinate.
 * @param position.y - Y coordinate.
 * @param createdBy - User id of the creator (caller injects from the store).
 * @returns A complete {@link CanvasNodeFields} for an empty content node.
 */
export function createEmptyNode(
  type: CreatableNodeType,
  position: { x: number; y: number },
  createdBy: string,
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
      state: 'idle',
      attachments: [],
    },
  };
}
