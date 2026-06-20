// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { CanvasNodeFields, NodeState } from '@breatic/shared';
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
    },
  };
}

/** Fixed English default name for a new group (not localized — see below). */
const GROUP_DEFAULT_NAME = 'Group';

/**
 * Builds a fresh group node wrapping the given child node ids, in the shared
 * wire shape. Pure (like {@link createEmptyNode}): `createdBy` is injected by
 * the caller so the factory stays free of React / store access.
 *
 * The default name is the fixed English `Group` — a data value, NOT a
 * localized label — for the same reason content-node default names are fixed
 * English: a localized default would freeze the creating client's locale into
 * the shared Yjs doc for every collaborator. `backgroundColor` stays unset
 * (neutral dashed frame) until the user picks one; the group has no lock and
 * no manual size (geometry is derived from children at render).
 * @param childIds - Ids of the nodes this group wraps. Copied, not aliased, so
 *   later mutation of the caller's array cannot leak into the node.
 * @param position - Canvas coordinates the group is placed at. Group geometry
 *   is derived from its children at render; this is only an initial value.
 * @param position.x - X coordinate.
 * @param position.y - Y coordinate.
 * @param createdBy - User id of the creator (caller injects from the store).
 * @returns A complete {@link CanvasNodeFields} for a group node.
 */
export function createEmptyGroup(
  childIds: ReadonlyArray<string>,
  position: { x: number; y: number },
  createdBy: string,
): CanvasNodeFields {
  return {
    id: newId(),
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
      childIds: [...childIds],
    },
  };
}
