// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { vi } from 'vitest';
import type * as Y from 'yjs';
import type * as ProviderModule from '@hocuspocus/provider';

/**
 * What a size-gate test reads and drives on a provider stand-in.
 *
 * Kept free of `@web` imports: `vi.mock('@hocuspocus/provider', …)` loads this
 * module from inside its factory, and anything here that imported the real
 * collab socket would import the module being mocked.
 */
export interface SizeGateProvider {
  document: Y.Doc;
  isAttached: boolean;
  isAuthenticated: boolean;
  authorizedScope: string | undefined;
  configuration: { name: string; document: Y.Doc; websocketProvider: SizeGateSocket };
  sendStateless: ReturnType<typeof vi.fn>;
  emit: (event: string, data?: unknown) => void;
  destroy: ReturnType<typeof vi.fn>;
}

/** The shared-socket stand-in, with the provider map `resetDocument` edits. */
export interface SizeGateSocket {
  status: string;
  webSocket: { readyState: number };
  configuration: { providerMap: Map<string, unknown> };
}

/** Every provider and socket stand-in built in the current test file, in order. */
export const sizeGateProviders: SizeGateProvider[] = [];
export const sizeGateSockets: SizeGateSocket[] = [];

/**
 * Builds the mocked `@hocuspocus/provider` module: the real exports with the
 * two transport classes replaced by recorders that never open a socket.
 * @param actual - The real module.
 * @returns The module to hand back from the `vi.mock` factory.
 */
export function providerMockModule(actual: typeof ProviderModule): typeof ProviderModule {
  class SocketStandIn {
    status = 'connected';
    webSocket = { readyState: 1 };
    receivedOnOpenPayload = new Event('open');
    configuration = { providerMap: new Map<string, unknown>() };
    on = vi.fn();
    off = vi.fn();
    destroy = vi.fn();
    /** Records itself. */
    constructor() { sizeGateSockets.push(this); }
  }
  class ProviderStandIn {
    isAttached = false;
    isAuthenticated = true;
    authorizedScope: string | undefined = 'read-write';
    synced = false;
    configuration: { name: string; document: Y.Doc; websocketProvider: SizeGateSocket };
    document: Y.Doc;
    sendStateless = vi.fn();
    listeners = new Map<string, Set<(data?: unknown) => void>>();
    on = vi.fn((event: string, callback: (data?: unknown) => void): void => {
      const callbacks = this.listeners.get(event) ?? new Set();
      callbacks.add(callback);
      this.listeners.set(event, callbacks);
    });
    off = vi.fn((event: string, callback: (data?: unknown) => void): void => {
      this.listeners.get(event)?.delete(callback);
    });
    /**
     * Delivers an event to every listener registered for it.
     * @param event - Event name.
     * @param data - Event payload.
     */
    emit(event: string, data?: unknown): void {
      for (const callback of [...(this.listeners.get(event) ?? [])]) callback(data);
    }
    attach = vi.fn((): void => {
      this.isAttached = true;
      this.configuration.websocketProvider.configuration.providerMap.set(this.configuration.name, this);
    });
    detach = vi.fn((): void => {
      this.isAttached = false;
      this.configuration.websocketProvider.configuration.providerMap.delete(this.configuration.name);
    });
    onOpen = vi.fn((): void => { this.isAuthenticated = false; });
    destroy = vi.fn((): void => { this.isAttached = false; });
    /**
     * Records itself.
     * @param configuration - The options the registry built it with.
     */
    constructor(configuration: { name: string; document: Y.Doc; websocketProvider: SizeGateSocket }) {
      this.configuration = configuration;
      this.document = configuration.document;
      sizeGateProviders.push(this as unknown as SizeGateProvider);
    }
  }
  return {
    ...actual,
    HocuspocusProviderWebsocket: SocketStandIn as unknown as typeof actual.HocuspocusProviderWebsocket,
    HocuspocusProvider: ProviderStandIn as unknown as typeof actual.HocuspocusProvider,
  };
}
