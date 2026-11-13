// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * How full each Space document is, as collab last pushed it (inner#1790).
 *
 * The store itself — the phases, the pushes, rebuilds — lives in
 * `@breatic/shared/canvas-model` (`doc-size-store.ts`, breatic#1488 §8.1);
 * this module adds the React hooks that follow it.
 */

import * as React from 'react';

import {
  readDocGeneration,
  readDocSize,
  subscribeDocGeneration,
  subscribeDocSize,
  type DocSizePhase,
  type DocSizeState,
} from '@breatic/shared/canvas-model';

export type { DocSizePhase, DocSizeState };
export {
  clearAllDocSizes,
  clearDocSize,
  docSizeSynced,
  isSpaceContentDoc,
  readDocSize,
  receiveDocSizePayload,
  setDocSize,
  startDocResync,
  subscribeDocSize,
} from '@breatic/shared/canvas-model';

/**
 * Follow a document's size.
 * @param name - Canonical document name.
 * @returns The state, updated on every change.
 */
export function useDocSize(name: string): DocSizeState {
  const subscribe = React.useCallback((listener: () => void): (() => void) => subscribeDocSize(name, listener), [name]);
  const read = React.useCallback((): DocSizeState => readDocSize(name), [name]);
  return React.useSyncExternalStore(subscribe, read);
}

/**
 * Follow a document's rebuild count.
 * @param name - Canonical document name.
 * @returns The count, updated on every rebuild.
 */
export function useDocGeneration(name: string): number {
  const subscribe = React.useCallback(
    (listener: () => void): (() => void) => subscribeDocGeneration(name, listener),
    [name],
  );
  const read = React.useCallback((): number => readDocGeneration(name), [name]);
  return React.useSyncExternalStore(subscribe, read);
}
