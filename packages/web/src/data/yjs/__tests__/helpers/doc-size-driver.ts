// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap (inner#1790): a recording stand-in for the
 * Hocuspocus provider and the events the spec drives through it (spec 0.3).
 *
 * Install it from a test file with
 * `vi.mock('@hocuspocus/provider', async (importOriginal) => (await import('@web/data/yjs/__tests__/helpers/doc-size-driver')).mockProviderModule(await importOriginal()))`.
 * This module imports no production module of the package: it is loaded from
 * inside that mock factory, while `collab-socket` is still importing the
 * provider.
 */

import { act } from '@testing-library/react';
import * as encoding from 'lib0/encoding';
import { vi } from 'vitest';
import type * as Y from 'yjs';

import { COLLAB_DOCUMENT_TOO_LARGE_REASON } from '@breatic/shared';
import { docSizePayload } from '@web/data/yjs/__tests__/helpers/doc-size-fixtures';

/** The shared-socket stand-in. */
export interface SocketSpy {
  status: string;
  webSocket: { readyState: number };
  receivedOnOpenPayload: Event;
  configuration: { providerMap: Map<string, unknown> };
  destroy: ReturnType<typeof vi.fn>;
}

/** The per-document provider stand-in. */
export interface ProviderSpy {
  document: Y.Doc;
  isAttached: boolean;
  isAuthenticated: boolean;
  authorizedScope: string | undefined;
  synced: boolean;
  configuration: { name: string; document: Y.Doc; websocketProvider: SocketSpy };
  sendStateless: ReturnType<typeof vi.fn>;
  attach: ReturnType<typeof vi.fn>;
  onOpen: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  /** For each `destroy()` call, whether the socket's providerMap still held this name (it would send CLOSE). */
  mappedAtDestroy: boolean[];
  emit: (event: string, data?: unknown) => void;
}

/** Every provider and socket constructed in the current test file, in order. */
export const providers: ProviderSpy[] = [];
export const sockets: SocketSpy[] = [];

/**
 * Builds the mocked `@hocuspocus/provider` module.
 * @param actual - The real module, for everything not replaced.
 * @returns The module with recording provider and socket classes.
 * @throws {never} Never.
 */
export function mockProviderModule(actual: object): object {
  /** Recording shared socket. */
  class HocuspocusProviderWebsocket {
    status = 'connected';
    webSocket = { readyState: 1 };
    receivedOnOpenPayload = new Event('open');
    configuration = { providerMap: new Map<string, unknown>() };
    on = vi.fn();
    off = vi.fn();
    destroy = vi.fn();
    /** Registers the socket. */
    constructor() { sockets.push(this); }
  }
  /** Recording document provider. */
  class HocuspocusProvider {
    isAttached = false;
    isAuthenticated = true;
    authorizedScope: string | undefined = 'read-write';
    synced = false;
    configuration: { name: string; document: Y.Doc; websocketProvider: SocketSpy };
    document: Y.Doc;
    sendStateless = vi.fn();
    flushPendingUpdates = vi.fn();
    mappedAtDestroy: boolean[] = [];
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
      this.configuration.websocketProvider.configuration.providerMap.set(this.configuration.name, this);
    });
    onOpen = vi.fn((): void => { this.isAuthenticated = false; });
    // Like the real detach: a name still in providerMap is where CLOSE would be sent.
    destroy = vi.fn((): void => {
      const map = this.configuration.websocketProvider.configuration.providerMap;
      this.mappedAtDestroy.push(map.has(this.configuration.name));
      if (map.get(this.configuration.name) === this) map.delete(this.configuration.name);
      this.isAttached = false;
    });
    /**
     * Records the provider.
     * @param configuration - Constructor options from `acquireDocProvider`.
     */
    constructor(configuration: { name: string; document: Y.Doc; websocketProvider: SocketSpy }) {
      this.configuration = configuration;
      this.document = configuration.document;
      providers.push(this as unknown as ProviderSpy);
    }
    /**
     * Delivers one provider event to the registered listeners.
     * @param event - Event name.
     * @param data - Event payload.
     */
    emit(event: string, data?: unknown): void {
      for (const callback of [...(this.listeners.get(event) ?? [])]) callback(data);
    }
  }
  return { ...actual, HocuspocusProviderWebsocket, HocuspocusProvider };
}

/**
 * Clears the recorded instances between tests.
 * @throws {never} Never.
 */
export function resetProviderSpies(): void {
  providers.length = 0;
  sockets.length = 0;
}

/**
 * The provider most recently constructed for one document name.
 * @param name - Canonical document name.
 * @returns The newest provider spy for it.
 * @throws {Error} When none was constructed.
 */
export function latestProvider(name: string): ProviderSpy {
  const found = providers.filter((p) => p.configuration.name === name).at(-1);
  if (found === undefined) throw new Error(`no provider for ${name}`);
  return found;
}

/**
 * Lets queued microtasks run inside act.
 * @returns Resolves after the flush.
 * @throws {never} Never.
 */
export async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

/**
 * Lets one macrotask (deferred provider teardown) run inside act.
 * @returns Resolves after the timers ran.
 * @throws {never} Never.
 */
export async function runTimers(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

/**
 * Sends one push on the stateless channel (`{ type: 'doc:size', ...push }`).
 * @param provider - The receiving provider.
 * @param push - The fixture, possibly altered.
 * @throws {never} Never.
 */
export function push(provider: ProviderSpy, push: object): void {
  act(() => { provider.emit('stateless', { payload: docSizePayload(push) }); });
}

/**
 * Sends a raw stateless payload.
 * @param provider - The receiving provider.
 * @param payload - The serialized message.
 * @throws {never} Never.
 */
export function pushRaw(provider: ProviderSpy, payload: string): void {
  act(() => { provider.emit('stateless', { payload }); });
}

/**
 * Delivers an incoming SyncStep1 for the document.
 * @param name - Canonical document name.
 * @param provider - The receiving provider.
 * @throws {never} Never.
 */
export function receiveStep1(name: string, provider: ProviderSpy): void {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, name);
  encoding.writeVarUint(encoder, 0);
  encoding.writeVarUint(encoder, 0);
  encoding.writeVarUint8Array(encoder, new Uint8Array([0]));
  provider.emit('message', { event: { data: encoding.toUint8Array(encoder) } });
}

/**
 * Authenticates read-write and completes the handshake, then flushes microtasks.
 * @param name - Canonical document name.
 * @param provider - The receiving provider.
 * @returns Resolves after the receipt microtasks ran.
 * @throws {never} Never.
 */
export async function handshake(name: string, provider: ProviderSpy): Promise<void> {
  provider.isAuthenticated = true;
  provider.authorizedScope = 'read-write';
  provider.isAttached = true;
  await act(async () => {
    provider.emit('authenticated', { scope: 'read-write' });
    receiveStep1(name, provider);
    await Promise.resolve();
  });
  await flush();
}

/**
 * The `sync:confirm` requests the provider sent, in order.
 * @param provider - The provider.
 * @returns The request bodies.
 * @throws {SyntaxError} When a sent body is not JSON.
 */
export function confirmRequests(provider: ProviderSpy): Array<{ type: string; id: string }> {
  return provider.sendStateless.mock.calls
    .map(([body]) => JSON.parse(String(body)) as { type: string; id: string })
    .filter((body) => body.type === 'sync:confirm');
}

/**
 * Answers one confirmation request.
 * @param provider - The provider.
 * @param id - The request id.
 * @returns Resolves after the follow-up microtasks ran.
 * @throws {never} Never.
 */
export async function confirmId(provider: ProviderSpy, id: string): Promise<void> {
  await act(async () => {
    provider.emit('stateless', { payload: JSON.stringify({ type: 'sync:confirmed', id, ok: true }) });
    await Promise.resolve();
  });
}

/**
 * Answers the latest confirmation request the provider sent.
 * @param provider - The provider.
 * @returns Resolves after the follow-up microtasks ran.
 * @throws {Error} When no request was sent.
 */
export async function confirmLatest(provider: ProviderSpy): Promise<void> {
  const last = confirmRequests(provider).at(-1);
  if (last === undefined) throw new Error('no sync:confirm request was sent');
  await confirmId(provider, last.id);
}

/**
 * The server refuses an update and closes the document (size limit).
 * @param provider - The provider whose document is closed.
 * @throws {never} Never.
 */
export function refuse(provider: ProviderSpy): void {
  act(() => { provider.emit('close', { event: { code: 1000, reason: COLLAB_DOCUMENT_TOO_LARGE_REASON } }); });
}

/**
 * An ordinary connection drop.
 * @param provider - The provider.
 * @throws {never} Never.
 */
export function disconnect(provider: ProviderSpy): void {
  act(() => { provider.emit('close', { event: { code: 1006, reason: '' } }); });
}

/**
 * The provider finished syncing.
 * @param provider - The provider.
 * @throws {never} Never.
 */
export function synced(provider: ProviderSpy): void {
  provider.synced = true;
  act(() => { provider.emit('synced', { state: true }); });
}
