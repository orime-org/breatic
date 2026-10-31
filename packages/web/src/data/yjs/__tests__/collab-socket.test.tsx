// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as Y from 'yjs';

// Spy transport. We assert how many shared sockets / per-doc providers get
// constructed + attached + destroyed, never opening a real WebSocket.
const { wsInstances, providerInstances } = vi.hoisted(() => ({
  wsInstances: [] as Array<{
    destroy: ReturnType<typeof vi.fn>;
    receivedOnOpenPayload?: Event;
    emit: (event: string, data?: unknown) => void;
    config: Record<string, unknown>;
  }>,
  providerInstances: [] as Array<{
    destroy: ReturnType<typeof vi.fn>;
    attach: ReturnType<typeof vi.fn>;
    onOpen: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    emit: (event: string, data?: unknown) => void;
    config: Record<string, unknown>;
  }>,
}));

vi.mock('@hocuspocus/provider', () => ({
  HocuspocusProviderWebsocket: class {
    destroy = vi.fn();
    receivedOnOpenPayload?: Event = undefined;
    listeners: Record<string, Array<(data?: unknown) => void>> = {};
    on(event: string, cb: (data?: unknown) => void): void {
      (this.listeners[event] ??= []).push(cb);
    }
    emit(event: string, data?: unknown): void {
      for (const cb of [...(this.listeners[event] ?? [])]) cb(data);
    }
    config: Record<string, unknown>;
    constructor(config: Record<string, unknown>) {
      this.config = config;
      wsInstances.push(this);
    }
  },
  HocuspocusProvider: class {
    destroy = vi.fn();
    attach = vi.fn();
    onOpen = vi.fn();
    // The registry subscribes to `synced` to latch "the content has arrived".
    listeners: Record<string, Array<(data?: unknown) => void>> = {};
    on = vi.fn((event: string, cb: (data?: unknown) => void) => {
      (this.listeners[event] ??= []).push(cb);
    });
    off = vi.fn((event: string, cb: (data?: unknown) => void) => {
      this.listeners[event] = (this.listeners[event] ?? []).filter((listener) => listener !== cb);
    });
    emit(event: string, data?: unknown): void {
      for (const cb of [...(this.listeners[event] ?? [])]) cb(data);
    }
    config: Record<string, unknown>;
    constructor(config: Record<string, unknown>) {
      this.config = config;
      providerInstances.push(this);
    }
  },
}));

vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
import { reportCollabFailure } from '@web/data/yjs/collab-failure-report';

import {
  acquireDocProvider,
  readDocFacts,
  readDocProvider,
  subscribeDocProvider,
  releaseDocProvider,
  _resetCollabSocketForTests,
} from '@web/data/yjs/collab-socket';
import { getDoc, _resetForTests as _resetDocsForTests } from '@web/data/yjs/manager';

const META = 'project-p1/meta';

describe('collab-socket manager — refcounted shared socket + deferred teardown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetCollabSocketForTests();
    _resetDocsForTests();
    wsInstances.length = 0;
    providerInstances.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads an existing provider without creating a connection', () => {
    expect(readDocProvider(META)).toBeNull();
    expect(providerInstances).toHaveLength(0);
    expect(wsInstances).toHaveLength(0);
    const provider = acquireDocProvider(META, getDoc(META));
    expect(readDocProvider(META)).toBe(provider);
    expect(providerInstances).toHaveLength(1);
    expect(wsInstances).toHaveLength(1);
  });

  it('observes provider creation and final destruction without retaining a reference', () => {
    const seen: unknown[] = [];
    const unsubscribe = subscribeDocProvider(META, () => seen.push(readDocProvider(META)));
    expect(readDocProvider(META)).toBeNull();
    expect(providerInstances).toHaveLength(0);
    const provider = acquireDocProvider(META, getDoc(META));
    expect(seen).toEqual([provider]);
    releaseDocProvider(META);
    vi.runOnlyPendingTimers();
    expect(seen).toEqual([provider, null]);
    expect(providerInstances[0].destroy).toHaveBeenCalledOnce();
    expect(readDocProvider(META)).toBeNull();
    unsubscribe();
  });

  it('isolates read-only observers by document and stops notifying after unsubscribe', () => {
    const changed = vi.fn();
    const unsubscribe = subscribeDocProvider(META, changed);
    acquireDocProvider('project-other/meta', getDoc('project-other/meta'));
    expect(changed).toHaveBeenCalledTimes(0);
    acquireDocProvider(META, getDoc(META));
    expect(changed).toHaveBeenCalledTimes(1);
    unsubscribe();
    releaseDocProvider(META);
    vi.runOnlyPendingTimers();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('WU08 builds the shared socket on ChunkingWebSocket, once per tab', async () => {
    const { ChunkingWebSocket } = await import('@web/data/yjs/chunking-websocket');
    acquireDocProvider(META, getDoc(META), '/ws');
    acquireDocProvider('project-p1/canvas-s1', getDoc('project-p1/canvas-s1'), '/ws');
    expect(wsInstances).toHaveLength(1);
    expect(wsInstances[0]!.config.WebSocketPolyfill).toBe(ChunkingWebSocket);
    expect(wsInstances[0]!.config.url).toBe(`ws://${window.location.host}/ws`);
  });

  it('creates ONE shared socket + attaches the provider on first acquire', () => {
    const doc = new Y.Doc();
    acquireDocProvider(META, doc);
    expect(wsInstances).toHaveLength(1);
    expect(providerInstances).toHaveLength(1);
    expect(providerInstances[0].attach).toHaveBeenCalledOnce();
    expect(providerInstances[0].config.websocketProvider).toBe(wsInstances[0]);
    expect(providerInstances[0].config.name).toBe(META);
    expect(providerInstances[0].config.document).toBe(doc);
  });

  it('shares ONE provider across repeat acquires of the same doc (refcount)', () => {
    const doc = new Y.Doc();
    const a = acquireDocProvider(META, doc);
    const b = acquireDocProvider(META, doc);
    expect(a).toBe(b);
    expect(providerInstances).toHaveLength(1);
  });

  it('StrictMode pattern: acquire → release → acquire tears down NOTHING (deferred release cancelled, #B)', () => {
    const doc = new Y.Doc();
    acquireDocProvider(META, doc); // mount setup
    releaseDocProvider(META); // StrictMode cleanup — schedules a deferred teardown
    acquireDocProvider(META, doc); // StrictMode re-setup — cancels it
    vi.runAllTimers();
    // No detach, no re-auth churn — exactly one provider, never destroyed.
    expect(providerInstances).toHaveLength(1);
    expect(providerInstances[0].destroy).not.toHaveBeenCalled();
    expect(wsInstances[0].destroy).not.toHaveBeenCalled();
  });

  it('a real release (no re-acquire) detaches the doc after the deferred tick', () => {
    const doc = new Y.Doc();
    acquireDocProvider(META, doc);
    releaseDocProvider(META);
    // Deferred: nothing torn down synchronously.
    expect(providerInstances[0].destroy).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(providerInstances[0].destroy).toHaveBeenCalledOnce(); // doc detached
    expect(wsInstances[0].destroy).toHaveBeenCalledOnce(); // last doc → socket closed
  });

  it('keeps the shared socket alive while other docs stay attached', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    acquireDocProvider('project-p1/canvas-a', docA);
    acquireDocProvider('project-p1/canvas-b', docB);
    expect(wsInstances).toHaveLength(1); // ONE socket for both docs

    releaseDocProvider('project-p1/canvas-a');
    vi.runAllTimers();
    const aProvider = providerInstances.find(
      (p) => p.config.name === 'project-p1/canvas-a',
    )!;
    expect(aProvider.destroy).toHaveBeenCalledOnce(); // doc A detached
    expect(wsInstances[0].destroy).not.toHaveBeenCalled(); // socket stays (doc B)

    releaseDocProvider('project-p1/canvas-b');
    vi.runAllTimers();
    expect(wsInstances[0].destroy).toHaveBeenCalledOnce(); // last doc → socket closed
  });

  // #1786: the Y.Doc lifecycle is co-located with the provider lifecycle — a
  // final release evicts the doc from the manager cache so nothing lingers (the
  // memory leak: destroyDoc had zero production callers).
  it('final release destroys + evicts the cached Y.Doc (#1786)', () => {
    const doc = getDoc(META);
    acquireDocProvider(META, doc);
    releaseDocProvider(META);
    // Deferred — the doc is still cached until the tick.
    expect(getDoc(META)).toBe(doc);
    vi.runAllTimers();
    // Evicted: a fresh getDoc returns a NEW instance (old doc destroyed + gone).
    expect(getDoc(META)).not.toBe(doc);
  });

  it('StrictMode acquire→release→acquire does NOT evict the cached doc (#1786)', () => {
    const doc = getDoc(META);
    acquireDocProvider(META, doc); // setup
    releaseDocProvider(META); // cleanup — schedules deferred evict
    acquireDocProvider(META, doc); // re-setup — cancels it
    vi.runAllTimers();
    // The re-acquire cancelled the deferred teardown → doc never evicted.
    expect(getDoc(META)).toBe(doc);
  });

  it('does not evict a still-referenced doc while another consumer holds it (refcount)', () => {
    const doc = getDoc(META);
    acquireDocProvider(META, doc); // consumer 1
    acquireDocProvider(META, doc); // consumer 2
    releaseDocProvider(META); // consumer 1 leaves — refcount 1, no teardown
    vi.runAllTimers();
    expect(getDoc(META)).toBe(doc); // still alive
    releaseDocProvider(META); // consumer 2 leaves — refcount 0
    vi.runAllTimers();
    expect(getDoc(META)).not.toBe(doc); // now evicted
  });

  it('releases the canonical scene document owned by its provider', () => {
    const name = 'project-p1/3d-s1';
    const doc = getDoc(name);
    acquireDocProvider(name, doc);
    releaseDocProvider(name, doc);
    vi.runAllTimers();
    expect(doc.isDestroyed).toBe(true);
    expect(getDoc(name)).not.toBe(doc);
  });

  it('keeps the same account document and provider across a deferred StrictMode remount', () => {
    const name = 'project-p1/3d-s1';
    const doc = getDoc(name);
    const first = acquireDocProvider(name, doc);
    releaseDocProvider(name, doc);
    const second = acquireDocProvider(name, getDoc(name));
    vi.runAllTimers();

    expect(second).toBe(first);
    expect(providerInstances).toHaveLength(1);
    expect(providerInstances[0].destroy).not.toHaveBeenCalled();
    expect(getDoc(name)).toBe(doc);
  });

  it('ignores late cleanup from a retired provider after the scene reopens', () => {
    const name = 'project-p1/3d-s1';
    const oldDoc = getDoc(name);
    acquireDocProvider(name, oldDoc);
    releaseDocProvider(name, oldDoc);
    vi.runAllTimers();
    expect(oldDoc.isDestroyed).toBe(true);
    const nextDoc = getDoc(name);
    const nextProvider = acquireDocProvider(name, nextDoc);
    releaseDocProvider(name, oldDoc);
    vi.runAllTimers();
    expect(providerInstances[1].destroy).not.toHaveBeenCalled();
    expect(getDoc(name)).toBe(nextDoc);
    expect(acquireDocProvider(name, nextDoc)).toBe(nextProvider);
  });

  it('destroys every cached provider during a synchronous test reset', () => {
    acquireDocProvider('project-p1/3d-s1', getDoc('project-p1/3d-s1'));
    acquireDocProvider(META, getDoc(META));
    _resetCollabSocketForTests();
    expect(providerInstances.every((provider) => provider.destroy.mock.calls.length === 1)).toBe(true);
    expect(wsInstances[0].destroy).toHaveBeenCalledOnce();
  });

  it('ignores events from a retired provider generation after the canonical name is reused', () => {
    const name = 'project-p1/3d-s1';
    acquireDocProvider(name, getDoc(name));
    const retired = providerInstances[0];
    releaseDocProvider(name);
    vi.runAllTimers();
    acquireDocProvider(name, getDoc(name));
    const current = providerInstances[1];

    retired.emit('synced');
    retired.emit('authenticationFailed', { reason: 'Old refusal' });
    retired.emit('close', { event: { reason: 'Session ended' } });
    expect(readDocFacts(name)).toEqual({ hasEverSynced: false, authFailure: null, sessionEnded: false });

    current.emit('close', { event: { reason: 'Session ended' } });
    retired.emit('authenticated');
    expect(readDocFacts(name).sessionEnded).toBe(true);
  });
});

describe('collab-socket manager — a document closed to be re-checked comes straight back', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetCollabSocketForTests();
    _resetDocsForTests();
    wsInstances.length = 0;
    providerInstances.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const OPEN = new Event('open');

  it('re-sends the token on the same socket when collab asks for it', () => {
    acquireDocProvider(META, getDoc(META));
    wsInstances[0].receivedOnOpenPayload = OPEN;
    providerInstances[0].emit('close', { event: { code: 1000, reason: 'Project archived' } });
    expect(providerInstances[0].onOpen).toHaveBeenCalledWith(OPEN);
  });

  it('does it for every reason collab sends for that purpose', () => {
    acquireDocProvider(META, getDoc(META));
    wsInstances[0].receivedOnOpenPayload = OPEN;
    for (const reason of [
      'Project archived',
      'Project restored',
      'Project content updated',
      'Permission changed, please reconnect',
    ]) {
      providerInstances[0].emit('close', { event: { code: 1000, reason } });
    }
    expect(providerInstances[0].onOpen).toHaveBeenCalledTimes(4);
  });

  it('leaves any other close alone', () => {
    acquireDocProvider(META, getDoc(META));
    wsInstances[0].receivedOnOpenPayload = OPEN;
    providerInstances[0].emit('close', { event: { code: 1000, reason: 'Document not found' } });
    providerInstances[0].emit('close', { event: { code: 1006, reason: '' } });
    expect(providerInstances[0].onOpen).not.toHaveBeenCalled();
  });

  it('waits for the socket when the socket itself is down', () => {
    acquireDocProvider(META, getDoc(META));
    providerInstances[0].emit('close', { event: { code: 1000, reason: 'Project archived' } });
    expect(providerInstances[0].onOpen).not.toHaveBeenCalled();
  });
});

describe('collab-socket manager — one report per closed connection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetCollabSocketForTests();
    _resetDocsForTests();
    wsInstances.length = 0;
    providerInstances.length = 0;
    vi.mocked(reportCollabFailure).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports a dropped connection once, with its code, reason and attached documents', () => {
    acquireDocProvider(META, getDoc(META));
    acquireDocProvider('project-p1/canvas-a', getDoc('project-p1/canvas-a'));
    acquireDocProvider('project-p1/canvas-b', getDoc('project-p1/canvas-b'));

    wsInstances[0].emit('open');
    wsInstances[0].emit('close', { event: { code: 4408, reason: 'Connection Timeout' } });

    expect(reportCollabFailure).toHaveBeenCalledOnce();
    expect(reportCollabFailure).toHaveBeenCalledWith({
      kind: 'disconnect',
      code: 4408,
      reason: 'Connection Timeout',
      documents: 3,
    });
  });

  it('reports a drop again once the connection has come back', () => {
    acquireDocProvider(META, getDoc(META));
    wsInstances[0].emit('open');
    wsInstances[0].emit('close', { event: { code: 1006, reason: '' } });
    wsInstances[0].emit('open');
    wsInstances[0].emit('close', { event: { code: 1006, reason: '' } });
    expect(reportCollabFailure).toHaveBeenCalledTimes(2);
  });

  it('does not report the reconnect attempts that fail while the connection is down', () => {
    acquireDocProvider(META, getDoc(META));
    wsInstances[0].emit('open');
    wsInstances[0].emit('close', { event: { code: 1006, reason: '' } });
    wsInstances[0].emit('close', { event: { code: 1006, reason: '' } });
    wsInstances[0].emit('close', { event: { code: 1006, reason: '' } });
    expect(reportCollabFailure).toHaveBeenCalledOnce();
  });

  it('does not report a first connection attempt that never opened', () => {
    acquireDocProvider(META, getDoc(META));
    wsInstances[0].emit('close', { event: { code: 1006, reason: '' } });
    expect(reportCollabFailure).not.toHaveBeenCalled();
  });

  it('does not report a document closed on its own while the connection stays up', () => {
    acquireDocProvider(META, getDoc(META));
    providerInstances[0].emit('close', { event: { code: 1000, reason: 'Connection Timeout' } });
    expect(reportCollabFailure).not.toHaveBeenCalled();
  });

  it('does not report the idle drop of a connection whose every document was refused', () => {
    // A signed-out session or a removed member: the server refuses every
    // document, nothing is sent any more, and the provider drops the idle
    // connection on its own every 30 seconds (inner#1548).
    acquireDocProvider(META, getDoc(META));
    acquireDocProvider('project-p1/canvas-a', getDoc('project-p1/canvas-a'));
    wsInstances[0].emit('open');
    providerInstances[0].emit('authenticationFailed', { reason: 'Session ended' });
    providerInstances[1].emit('authenticationFailed', { reason: 'Session ended' });

    wsInstances[0].emit('close', { event: { code: 1005, reason: '' } });

    expect(reportCollabFailure).not.toHaveBeenCalled();
  });

  it('reports the drop when any attached document is still accepted', () => {
    acquireDocProvider(META, getDoc(META));
    acquireDocProvider('project-p1/canvas-a', getDoc('project-p1/canvas-a'));
    wsInstances[0].emit('open');
    providerInstances[1].emit('authenticationFailed', { reason: 'Forbidden' });

    wsInstances[0].emit('close', { event: { code: 1006, reason: '' } });

    expect(reportCollabFailure).toHaveBeenCalledOnce();
  });
});
