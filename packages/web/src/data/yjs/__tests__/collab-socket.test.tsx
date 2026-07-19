// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as Y from 'yjs';

// Spy transport. We assert how many shared sockets / per-doc providers get
// constructed + attached + destroyed, never opening a real WebSocket.
const { wsInstances, providerInstances } = vi.hoisted(() => ({
  wsInstances: [] as Array<{ destroy: ReturnType<typeof vi.fn> }>,
  providerInstances: [] as Array<{
    destroy: ReturnType<typeof vi.fn>;
    attach: ReturnType<typeof vi.fn>;
    config: Record<string, unknown>;
  }>,
}));

vi.mock('@hocuspocus/provider', () => ({
  HocuspocusProviderWebsocket: class {
    destroy = vi.fn();
    constructor() {
      wsInstances.push(this);
    }
  },
  HocuspocusProvider: class {
    destroy = vi.fn();
    attach = vi.fn();
    config: Record<string, unknown>;
    constructor(config: Record<string, unknown>) {
      this.config = config;
      providerInstances.push(this);
    }
  },
}));

import {
  acquireDocProvider,
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

  it('creates ONE shared socket + attaches the provider on first acquire', () => {
    const doc = new Y.Doc();
    acquireDocProvider(META, doc);
    expect(wsInstances).toHaveLength(1);
    expect(providerInstances).toHaveLength(1);
    expect(providerInstances[0]!.attach).toHaveBeenCalledOnce();
    expect(providerInstances[0]!.config.websocketProvider).toBe(wsInstances[0]);
    expect(providerInstances[0]!.config.name).toBe(META);
    expect(providerInstances[0]!.config.document).toBe(doc);
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
    expect(providerInstances[0]!.destroy).not.toHaveBeenCalled();
    expect(wsInstances[0]!.destroy).not.toHaveBeenCalled();
  });

  it('a real release (no re-acquire) detaches the doc after the deferred tick', () => {
    const doc = new Y.Doc();
    acquireDocProvider(META, doc);
    releaseDocProvider(META);
    // Deferred: nothing torn down synchronously.
    expect(providerInstances[0]!.destroy).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(providerInstances[0]!.destroy).toHaveBeenCalledOnce(); // doc detached
    expect(wsInstances[0]!.destroy).toHaveBeenCalledOnce(); // last doc → socket closed
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
    expect(wsInstances[0]!.destroy).not.toHaveBeenCalled(); // socket stays (doc B)

    releaseDocProvider('project-p1/canvas-b');
    vi.runAllTimers();
    expect(wsInstances[0]!.destroy).toHaveBeenCalledOnce(); // last doc → socket closed
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
});
