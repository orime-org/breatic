// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap v2 (inner#1790): a provider stand-in for cases that
 * need a registered, authenticated and synced document connection (an entry
 * that waits for `readDocConnection`), without opening a socket.
 *
 * Install it with
 * `vi.mock('@hocuspocus/provider', async (importOriginal) => (await import('@web/data/yjs/__tests__/helpers/size-v2-provider')).providerModuleV2(await importOriginal()))`.
 * It imports no production module of the package: it is loaded from inside
 * that mock factory, while `collab-socket` is still importing the provider.
 */

import { vi } from 'vitest';
import type * as Y from 'yjs';

/** What a case reads and drives on a provider stand-in. */
export interface ProviderV2 {
  document: Y.Doc;
  isAttached: boolean;
  isAuthenticated: boolean;
  authorizedScope: string | undefined;
  synced: boolean;
  configuration: { name: string; document: Y.Doc };
  sendStateless: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  emit: (event: string, data?: unknown) => void;
}

/** Every provider stand-in built in the current test file, in order. */
export const providersV2: ProviderV2[] = [];

/**
 * Builds the mocked `@hocuspocus/provider` module: the real exports with the
 * two transport classes replaced by recorders. A provider starts attached,
 * authenticated and writable.
 * @param actual - The real module.
 * @returns The module to hand back from the `vi.mock` factory.
 * @throws {never} Never.
 */
export function providerModuleV2(actual: object): object {
  /** Shared-socket stand-in. */
  class SocketStandIn {
    status = 'connected';
    webSocket = { readyState: 1 };
    receivedOnOpenPayload = new Event('open');
    configuration = { providerMap: new Map<string, unknown>() };
    on = vi.fn();
    off = vi.fn();
    destroy = vi.fn();
  }
  /** Document provider stand-in. */
  class ProviderStandIn {
    isAttached = true;
    isAuthenticated = true;
    authorizedScope: string | undefined = 'read-write';
    synced = false;
    configuration: { name: string; document: Y.Doc; websocketProvider: SocketStandIn };
    document: Y.Doc;
    sendStateless = vi.fn();
    flushPendingUpdates = vi.fn();
    listeners = new Map<string, Set<(data?: unknown) => void>>();
    on = vi.fn((event: string, callback: (data?: unknown) => void): void => {
      const callbacks = this.listeners.get(event) ?? new Set();
      callbacks.add(callback);
      this.listeners.set(event, callbacks);
    });
    off = vi.fn((event: string, callback: (data?: unknown) => void): void => {
      this.listeners.get(event)?.delete(callback);
    });
    attach = vi.fn((): void => {
      this.isAttached = true;
    });
    detach = vi.fn((): void => {
      this.isAttached = false;
    });
    onOpen = vi.fn();
    destroy = vi.fn((): void => {
      this.isAttached = false;
    });
    /**
     * Records itself.
     * @param configuration - The options the registry built it with.
     */
    constructor(configuration: { name: string; document: Y.Doc; websocketProvider: SocketStandIn }) {
      this.configuration = configuration;
      this.document = configuration.document;
      providersV2.push(this);
    }
    /**
     * Delivers an event to every listener registered for it.
     * @param event - Event name.
     * @param data - Event payload.
     */
    emit(event: string, data?: unknown): void {
      for (const callback of [...(this.listeners.get(event) ?? [])]) callback(data);
    }
  }
  return { ...actual, HocuspocusProviderWebsocket: SocketStandIn, HocuspocusProvider: ProviderStandIn };
}

/**
 * The newest provider stand-in built for a document name.
 * @param name - Document name.
 * @returns The provider.
 * @throws {Error} When none was built for the name.
 */
export function latestProviderV2(name: string): ProviderV2 {
  const found = [...providersV2].reverse().find((p) => p.configuration.name === name);
  if (!found) throw new Error(`no provider was built for ${name}`);
  return found;
}

/**
 * Reports the provider's first sync.
 * @param provider - The provider.
 * @throws {never} Never.
 */
export function syncProviderV2(provider: ProviderV2): void {
  provider.synced = true;
  provider.emit('synced', { state: true });
}
