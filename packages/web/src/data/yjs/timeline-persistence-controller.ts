// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as Y from 'yjs';
import {
  newId, readTimelineDocument, sameNativeEditRecord, TimelinePersistenceResponseSchema,
  type NativeEditRecord, type TimelineClientLimits, type TimelinePersistenceRequest, type TimelinePersistenceResponse,
} from '@breatic/shared';
import { createDocScopedCache } from '@web/data/yjs/doc-scoped-cache';
import { sendCorrelatedRpc, type RpcCapableProvider } from '@web/data/yjs/stateless-rpc-client';

/** One stable external-store snapshot, independent from socket synchronization. */
export interface TimelinePersistenceSnapshot {
  status: 'checking' | 'saving' | 'saved' | 'error' | 'incompatible' | 'disconnected';
  pendingCount: number;
  error: string | null;
}

/** Document-lifetime dependencies; only the Space layer supplies a close guard. */
export interface TimelinePersistenceOptions {
  limits: TimelineClientLimits['persistence'];
  onPendingChange?: (pending: boolean) => void;
  send?: (provider: RpcCapableProvider, request: Omit<TimelinePersistenceRequest, 'id'>, signal: AbortSignal) => Promise<TimelinePersistenceResponse>;
}

/** A single observer, RPC generation and bounded polling loop per content document. */
export interface TimelinePersistenceController {
  setConnection: (provider: RpcCapableProvider | null) => void;
  retry: () => Promise<void>;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => TimelinePersistenceSnapshot;
  destroy: () => void;
}

/**
 * Confirm exact immutable edit receipts by querying actual persisted content.
 * @param doc - The actual managed Timeline content document.
 * @param options - Configured request bounds, close guard and optional test transport.
 * @returns The document-lifetime confirmation controller.
 * @throws {never} Read and transport failures are exposed through the snapshot.
 */
export function createTimelinePersistenceController(doc: Y.Doc, options: TimelinePersistenceOptions): TimelinePersistenceController {
  let connection: RpcCapableProvider | null = null;
  let generation = 0;
  let disposed = false;
  let validDocument = false;
  let verifiedDocument = false;
  let records = new Map<string, NativeEditRecord>();
  const confirmed = new Map<string, NativeEditRecord>();
  const listeners = new Set<() => void>();
  let snapshot: TimelinePersistenceSnapshot = Object.freeze({ status: 'disconnected', pendingCount: 0, error: null });
  let pendingGuard = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active: Promise<void> | null = null;
  let activeAbort: AbortController | null = null;
  let retryWaiting: Promise<void> | null = null;
  let lastRetryAt: number | null = null;

  /**
   * Read the unconfirmed records without substituting identity for full equality.
   * @returns The current pending action identities.
   */
  const pendingIds = (): string[] => [...records].filter(([id, record]) => !sameNativeEditRecord(record, confirmed.get(id))).map(([id]) => id);

  /**
   * Publish one stable snapshot and balance the close guard on its own transitions.
   * @param status - Current confirmation state.
   * @param error - A server or diagnostic error, separate from the state label.
   */
  const publish = (status: TimelinePersistenceSnapshot['status'], error: string | null = null): void => {
    const pendingCount = pendingIds().length;
    const guard = pendingCount > 0;
    if (guard !== pendingGuard) {
      pendingGuard = guard;
      options.onPendingChange?.(guard);
    }
    if (snapshot.status === status && snapshot.pendingCount === pendingCount && snapshot.error === error) return;
    snapshot = Object.freeze({ status, pendingCount, error });
    listeners.forEach((listener) => listener());
  };

  /** Release this controller's one scheduled read. */
  const clearPoll = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  /**
   * Decode current content without seeding or changing its layout.
   * @returns Whether this document is compatible with the controller.
   */
  const readRecords = (): boolean => {
    try {
      const value = readTimelineDocument(doc);
      records = new Map(Object.entries(value.nativeEdits));
      for (const [id, record] of records) {
        if (record.actionId !== id || (confirmed.has(id) && !sameNativeEditRecord(record, confirmed.get(id)))) {
          validDocument = false;
          publish('incompatible', 'Timeline edit receipt changed');
          return false;
        }
      }
      validDocument = true;
      return true;
    } catch (error) {
      validDocument = false;
      publish('incompatible', error instanceof Error ? error.message : 'Invalid Timeline document');
      return false;
    }
  };

  /** Schedule another SQL read while confirmation is unresolved. */
  const schedulePoll = (): void => {
    clearPoll();
    if (disposed || connection === null || !validDocument || snapshot.status === 'incompatible') return;
    if (pendingIds().length === 0 && verifiedDocument) return;
    timer = setTimeout(() => {
      timer = null;
      void run('timeline:persistence:query');
    }, options.limits.pollIntervalMs);
  };

  /**
   * Run bounded batches through one current provider generation.
   * @param type - A read, or the user's explicit store-and-read request.
   * @param includeConfirmed - Recheck current bytes after a connection change.
   * @returns After this request sequence settles, retaining unresolved receipts.
   */
  const run = (type: TimelinePersistenceRequest['type'], includeConfirmed = false): Promise<void> => {
    if (active !== null) return active;
    if (disposed || connection === null || !validDocument) return Promise.resolve();
    clearPoll();
    const provider = connection;
    const epoch = generation;
    const abort = new AbortController();
    activeAbort = abort;
    const ids = includeConfirmed ? [...records.keys()] : pendingIds();
    const captured = new Map(records);
    const batches: string[][] = [];
    for (let offset = 0; offset < ids.length; offset += options.limits.batchSize) batches.push(ids.slice(offset, offset + options.limits.batchSize));
    if (batches.length === 0) batches.push([]);
    publish(pendingIds().length > 0 ? 'saving' : verifiedDocument ? 'saved' : 'checking');
    const work = (async (): Promise<void> => {
      let anomaly: string | null = null;
      try {
        for (const actionIds of batches) {
          const request: Omit<TimelinePersistenceRequest, 'id'> = { version: 1, type, payload: { actionIds } };
          const reply = options.send === undefined
            ? await sendCorrelatedRpc(provider, { ...request, id: newId() }, TimelinePersistenceResponseSchema, { timeoutMs: options.limits.rpcTimeoutMs, signal: abort.signal })
            : await options.send(provider, request, abort.signal);
          if (disposed || epoch !== generation) return;
          const response = TimelinePersistenceResponseSchema.parse(reply);
          if (!response.ok) {
            if (response.error.code === 'UNSUPPORTED_DOCUMENT') publish('incompatible', response.error.message);
            else publish(pendingIds().length === 0 && verifiedDocument ? 'saved' : 'error', response.error.message);
            return;
          }
          verifiedDocument = true;
          if (response.result.missingActionIds.some((id) => actionIds.includes(id) && confirmed.has(id))) {
            anomaly = 'Persisted Timeline omitted a previously confirmed edit receipt';
          }
          for (const record of response.result.persistedRecords) {
            if (!actionIds.includes(record.actionId)) continue;
            const expected = captured.get(record.actionId);
            if (expected === undefined || !sameNativeEditRecord(expected, record) || !sameNativeEditRecord(records.get(record.actionId), record)) {
              publish('incompatible', 'Persisted Timeline edit receipt differs');
              return;
            }
            confirmed.set(record.actionId, expected);
          }
          publish(pendingIds().length === 0 ? 'saved' : 'saving', anomaly);
        }
      } catch (error) {
        if (disposed || epoch !== generation) return;
        publish(pendingIds().length === 0 && verifiedDocument ? 'saved' : 'error', error instanceof Error ? error.message : 'Timeline persistence read failed');
      }
    })();
    active = work.finally(() => {
      if (disposed || epoch !== generation) return;
      active = null;
      activeAbort = null;
      schedulePoll();
    });
    return active;
  };

  /** Recompute pending facts on document changes, sharing any in-flight read. */
  const onUpdate = (): void => {
    if (disposed || !readRecords()) return;
    publish(connection === null ? 'disconnected' : pendingIds().length > 0 ? 'saving' : verifiedDocument ? 'saved' : 'checking');
    if (connection !== null && (pendingIds().length > 0 || !verifiedDocument)) void run('timeline:persistence:query');
  };

  /**
   * Issue one user-requested store attempt, sharing concurrent retry presses.
   * @returns After the attempt and its persisted-byte read complete.
   */
  const retry = (): Promise<void> => {
    if (disposed || connection === null || !validDocument || (pendingIds().length === 0 && verifiedDocument)) return Promise.resolve();
    if (retryWaiting !== null) return retryWaiting;
    if (active !== null) {
      const epoch = generation;
      retryWaiting = active.then(() => {
        if (disposed || epoch !== generation) return;
        retryWaiting = null;
        return retry();
      });
      return retryWaiting;
    }
    if (lastRetryAt !== null && Date.now() - lastRetryAt < options.limits.retryMinIntervalMs) return Promise.resolve();
    lastRetryAt = Date.now();
    return run('timeline:persistence:retry');
  };

  readRecords();
  if (validDocument) publish('disconnected');
  doc.on('update', onUpdate);

  return {
    /**
     * Replace the active generation and recheck actual bytes on its provider.
     * @param provider - The current synchronized connection, or null while unavailable.
     */
    setConnection(provider: RpcCapableProvider | null): void {
      if (disposed || provider === connection) return;
      generation += 1;
      activeAbort?.abort();
      activeAbort = null;
      active = null;
      retryWaiting = null;
      clearPoll();
      connection = provider;
      if (!readRecords()) return;
      if (provider === null) publish('disconnected');
      else void run('timeline:persistence:query', true);
    },
    retry,
    /**
     * Subscribe a rendering consumer without owning the document's lifetime.
     * @param listener - Called after a snapshot change.
     * @returns The consumer's unsubscribe operation.
     */
    subscribe(listener: () => void): () => void {
      if (!disposed) listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    /**
     * Read the stable snapshot for useSyncExternalStore.
     * @returns The current immutable confirmation state.
     */
    getSnapshot(): TimelinePersistenceSnapshot { return snapshot; },
    /** End this document's waiters, timers and observer on real document disposal. */
    destroy(): void {
      if (disposed) return;
      disposed = true;
      generation += 1;
      clearPoll();
      activeAbort?.abort();
      activeAbort = null;
      active = null;
      connection = null;
      retryWaiting = null;
      doc.off('update', onUpdate);
      listeners.clear();
      confirmed.clear();
      records.clear();
      pendingGuard = false;
      options.onPendingChange?.(false);
    },
  };
}

const controllers = createDocScopedCache<TimelinePersistenceController, TimelinePersistenceOptions>(
  (doc, options) => createTimelinePersistenceController(doc, options),
  (controller) => controller.destroy(),
);

/**
 * Bind confirmation state to the actual managed Y.Doc across Space visibility changes.
 * @param doc - The actual document held by the manager.
 * @param name - Its canonical content name.
 * @param options - Construction dependencies used only for a new controller.
 * @returns The single controller retained until destroyDoc evicts it.
 * @throws {never} Read failures are exposed through its snapshot.
 */
export function getTimelinePersistenceController(doc: Y.Doc, name: string, options: TimelinePersistenceOptions): TimelinePersistenceController {
  return controllers.get(doc, name, options);
}
