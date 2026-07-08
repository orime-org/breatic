// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

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
 *
 * Operations are REFERENCE-COUNTED per (space, operationId), not a presence map:
 * two front-end operations can target the SAME node id (a slow upload from a
 * double-click while a second upload on that node is refused by the busy gate
 * but still registers + unregisters). Without a refcount the second's
 * unregister would clear the guard for the first, still-running upload, closing
 * the tab and losing the in-flight write-back (adversarial finding, #1617). The
 * space stays busy until every registration has a matching unregister.
 */
interface SpaceOperationsState {
  /** spaceId → (operationId → refcount). A space is "busy" while its inner map is non-empty (every entry has count ≥ 1). */
  operations: Record<string, Record<string, number>>;
  /** Register one in-flight front-end operation on a space (increments its refcount). */
  register: (spaceId: string, operationId: string) => void;
  /** Release one operation once it settles (decrements the refcount; entry + empty spaces are pruned at zero). */
  unregister: (spaceId: string, operationId: string) => void;
  /** Whether the given space has any in-flight front-end operation. */
  hasOperations: (spaceId: string) => boolean;
  /** Whether any space has an in-flight front-end operation (for `beforeunload`). */
  hasAnyOperations: () => boolean;
}

export const useSpaceOperationsStore = create<SpaceOperationsState>()(
  immer((set, get) => ({
    operations: {},
    register: (spaceId, operationId) =>
      set((s) => {
        const forSpace = (s.operations[spaceId] ??= {});
        forSpace[operationId] = (forSpace[operationId] ?? 0) + 1;
      }),
    unregister: (spaceId, operationId) =>
      set((s) => {
        const forSpace = s.operations[spaceId];
        if (!forSpace) return;
        const next = (forSpace[operationId] ?? 0) - 1;
        if (next > 0) {
          forSpace[operationId] = next;
        } else {
          delete forSpace[operationId];
          if (Object.keys(forSpace).length === 0) delete s.operations[spaceId];
        }
      }),
    hasOperations: (spaceId) =>
      Object.keys(get().operations[spaceId] ?? {}).length > 0,
    hasAnyOperations: () =>
      Object.values(get().operations).some(
        (forSpace) => Object.keys(forSpace).length > 0,
      ),
  })),
);
