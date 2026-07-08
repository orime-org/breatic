// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

/** Metadata attached to a registered operation (reserved for future toast copy). */
interface OperationMeta {
  /** Human label for the operation kind (e.g. "upload"). Unused by v1 gating. */
  label?: string;
}

/**
 * Per-space front-end operation registry (#1617).
 *
 * A front-end operation (first registrant: an in-flight upload) that writes its
 * result back through the user's LOCAL Yjs doc must finish while the space's tab
 * is open — closing the tab detaches the doc (`releaseDocProvider`), so an
 * un-synced local write-back is lost if the space is never reopened. This store
 * is the single source of truth for "is a front-end operation in progress",
 * keyed by space so a tab-close checks only that space and `beforeunload` checks
 * all of them.
 *
 * It is deliberately NOT derived from Yjs `handling` state: that also covers
 * backend AIGC, which writes back via the server-side collab doc and survives a
 * tab close — those must not block closing.
 */
interface SpaceOperationsState {
  /** spaceId → (operationId → meta). A space is "busy" while its inner map is non-empty. */
  operations: Record<string, Record<string, OperationMeta>>;
  /** Register an in-flight front-end operation on a space (idempotent per id). */
  register: (spaceId: string, operationId: string, meta?: OperationMeta) => void;
  /** Clear an operation once it settles (success or failure); empty spaces are pruned. */
  unregister: (spaceId: string, operationId: string) => void;
  /** Whether the given space has any in-flight front-end operation. */
  hasOperations: (spaceId: string) => boolean;
  /** Whether any space has an in-flight front-end operation (for `beforeunload`). */
  hasAnyOperations: () => boolean;
}

export const useSpaceOperationsStore = create<SpaceOperationsState>()(
  immer((set, get) => ({
    operations: {},
    register: (spaceId, operationId, meta = {}) =>
      set((s) => {
        (s.operations[spaceId] ??= {})[operationId] = meta;
      }),
    unregister: (spaceId, operationId) =>
      set((s) => {
        const forSpace = s.operations[spaceId];
        if (!forSpace) return;
        delete forSpace[operationId];
        if (Object.keys(forSpace).length === 0) delete s.operations[spaceId];
      }),
    hasOperations: (spaceId) =>
      Object.keys(get().operations[spaceId] ?? {}).length > 0,
    hasAnyOperations: () =>
      Object.values(get().operations).some(
        (forSpace) => Object.keys(forSpace).length > 0,
      ),
  })),
);
