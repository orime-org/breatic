// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Facts owned by one content document's provider entry. */
export interface DocSyncState {
  localVersion: number;
  confirmedVersion: number;
  epoch: number;
  handshakeComplete: boolean;
  pending: { id: string; epoch: number; requestedVersion: number } | null;
}

/** Inputs that advance the document's confirmation lifecycle. */
export type DocSyncEvent =
  | { type: 'local-update' }
  | { type: 'remote-update' }
  | { type: 'handshake-complete'; epoch: number }
  | { type: 'request-sent'; id: string }
  | { type: 'response'; id: string; epoch: number; ok: boolean }
  | { type: 'invalidate' };

/**
 * Creates the facts for a newly acquired document.
 * @returns The initial clean state.
 * @throws {never} Never.
 */
export function createDocSyncState(): DocSyncState {
  return { localVersion: 0, confirmedVersion: 0, epoch: 0, handshakeComplete: false, pending: null };
}

/**
 * Applies one lifecycle input while preserving the request's version snapshot.
 * @param state - Current document facts.
 * @param event - Observed lifecycle input.
 * @returns The next facts.
 * @throws {never} Never.
 */
export function transitionDocSync(state: DocSyncState, event: DocSyncEvent): DocSyncState {
  switch (event.type) {
    case 'local-update':
      return { ...state, localVersion: state.localVersion + 1 };
    case 'remote-update':
      return state;
    case 'invalidate':
      return { ...state, epoch: state.epoch + 1, handshakeComplete: false, pending: null };
    case 'handshake-complete':
      return event.epoch === state.epoch ? { ...state, handshakeComplete: true } : state;
    case 'request-sent':
      if (!state.handshakeComplete || state.pending !== null || state.localVersion === state.confirmedVersion) return state;
      return { ...state, pending: { id: event.id, epoch: state.epoch, requestedVersion: state.localVersion } };
    case 'response': {
      const pending = state.pending;
      if (pending === null || pending.id !== event.id || pending.epoch !== state.epoch || event.epoch !== state.epoch) return state;
      return event.ok
        ? { ...state, confirmedVersion: pending.requestedVersion, pending: null }
        : { ...state, handshakeComplete: false, pending: null };
    }
  }
}
