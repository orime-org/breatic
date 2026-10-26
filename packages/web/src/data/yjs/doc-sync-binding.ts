// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { MessageType, type HocuspocusProvider } from '@hocuspocus/provider';
import * as decoding from 'lib0/decoding';
import { messageYjsSyncStep1 } from 'y-protocols/sync';
import type * as Y from 'yjs';

import { newId, SyncConfirmedResponseSchema, type SyncConfirmRequest } from '@breatic/shared';
import { createDocSyncState, transitionDocSync, type DocSyncEvent } from '@web/data/yjs/doc-sync';

/** The observations retained by one provider registry entry. */
export interface DocSyncBinding {
  hasUnsyncedEdits: () => boolean;
  dispose: () => void;
}

/**
 * Tracks local edits and barriers on the content provider's own Connection.
 * @param name - Canonical content document name.
 * @param doc - Document owned by the provider entry.
 * @param provider - Provider whose original owner controls attachment.
 * @param changed - Publishes changes to the derived unsynced fact.
 * @returns The entry-owned read and cleanup handles.
 * @throws {never} Registration itself does not throw.
 */
export function bindDocSync(name: string, doc: Y.Doc, provider: HocuspocusProvider, changed: () => void): DocSyncBinding {
  let state = createDocSyncState();
  let active = true;

  /**
   * Reads the version difference without storing a second dirty flag.
   * @returns Whether local edits await a matching receipt.
   * @throws {never} Never.
   */
  function hasUnsyncedEdits(): boolean {
    return state.localVersion > state.confirmedVersion;
  }

  /**
   * Advances the sole mutable facts and publishes a changed risk value.
   * @param event - Current lifecycle input.
   * @throws {never} Never.
   */
  function apply(event: DocSyncEvent): void {
    const before = hasUnsyncedEdits();
    state = transitionDocSync(state, event);
    if (hasUnsyncedEdits() !== before) changed();
  }

  /**
   * Sends at most one receipt after the provider has sent the covered updates.
   * @throws {Error} Propagates provider send failures after invalidating the request.
   */
  function sendConfirmation(): void {
    if (!active || !state.handshakeComplete || state.pending !== null || !hasUnsyncedEdits()) return;
    if (!provider.isAttached || !provider.isAuthenticated || provider.authorizedScope !== 'read-write') return;
    if (provider.configuration.websocketProvider.webSocket?.readyState !== WebSocket.OPEN) return;
    const request: SyncConfirmRequest = { type: 'sync:confirm', id: newId() };
    apply({ type: 'request-sent', id: request.id });
    try {
      provider.sendStateless(JSON.stringify(request));
    } catch (err) {
      apply({ type: 'invalidate' });
      throw err;
    }
  }

  /**
   * Schedules the barrier after synchronous provider Update or Step2 sends.
   * @param handshake - Whether this task follows receipt of SyncStep1.
   * @throws {never} Scheduling does not throw.
   */
  function scheduleConfirmation(handshake = false): void {
    const epoch = state.epoch;
    queueMicrotask(() => {
      if (!active || state.epoch !== epoch) return;
      if (handshake) apply({ type: 'handshake-complete', epoch });
      sendConfirmation();
    });
  }

  /**
   * Observes every local update, including pure deletions.
   * @param _update - Encoded Yjs update.
   * @param origin - Source of the transaction.
   * @param _doc - Updated document.
   * @param transaction - Yjs transaction metadata.
   * @throws {never} Never.
   */
  function onUpdate(_update: Uint8Array, origin: unknown, _doc: Y.Doc, transaction: Y.Transaction): void {
    if (!active || !transaction.local || origin === provider) return;
    apply({ type: 'local-update' });
    scheduleConfirmation();
  }

  /**
   * Observes Step1 before the library synchronously sends its Step2 reply.
   * @param data - Provider's independent incoming message notification.
   * @param data.event - Incoming transport event.
   * @param data.event.data - Encoded protocol frame.
   * @throws {Error} Propagates invalid protocol-frame decoding.
   */
  function onMessage(data: { event: { data: ArrayBuffer | Uint8Array } }): void {
    if (!active) return;
    const decoder = decoding.createDecoder(new Uint8Array(data.event.data));
    if (decoding.readVarString(decoder) !== name) return;
    const type = decoding.readVarUint(decoder);
    if (type !== MessageType.Sync) return;
    if (decoding.readVarUint(decoder) === messageYjsSyncStep1) scheduleConfirmation(true);
  }

  /**
   * Accepts only a valid receipt for the current immutable request snapshot.
   * @param data - Stateless application payload.
   * @param data.payload - Serialized receipt.
   * @throws {never} Invalid application messages leave the facts unchanged.
   */
  function onStateless(data: { payload: string }): void {
    if (!active) return;
    let value: unknown;
    try {
      value = JSON.parse(data.payload);
    } catch {
      return;
    }
    const response = SyncConfirmedResponseSchema.safeParse(value);
    if (!response.success || state.pending?.id !== response.data.id) return;
    apply({ type: 'response', id: response.data.id, epoch: state.epoch, ok: response.data.ok });
    if (response.data.ok) scheduleConfirmation();
  }

  /**
   * Invalidates callbacks from a closed or refused connection.
   * @throws {never} Never.
   */
  function invalidate(): void {
    if (active) apply({ type: 'invalidate' });
  }

  doc.on('update', onUpdate);
  provider.on('message', onMessage);
  provider.on('stateless', onStateless);
  provider.on('close', invalidate);
  provider.on('authenticationFailed', invalidate);

  return {
    hasUnsyncedEdits,
    dispose: (): void => {
      active = false;
      state = transitionDocSync(state, { type: 'invalidate' });
      doc.off('update', onUpdate);
      provider.off('message', onMessage);
      provider.off('stateless', onStateless);
      provider.off('close', invalidate);
      provider.off('authenticationFailed', invalidate);
    },
  };
}
