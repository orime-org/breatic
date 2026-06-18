// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import * as React from 'react';
import * as Y from 'yjs';

// Spy transport. Records every shared HocuspocusProviderWebsocket + per-doc
// HocuspocusProvider so we can assert the doc attaches to the SHARED socket and
// that switching docs never tears the shared socket down (#1378 churn). The
// provider also needs on/off (useSocket subscribes for status) + a `synced`
// flag (useSocket reads the current state on acquire).
const { wsInstances, providerInstances } = vi.hoisted(() => ({
  wsInstances: [] as Array<{ destroy: ReturnType<typeof vi.fn> }>,
  providerInstances: [] as Array<{
    destroy: ReturnType<typeof vi.fn>;
    attach: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    synced: boolean;
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
    on = vi.fn();
    off = vi.fn();
    synced = false;
    config: Record<string, unknown>;
    constructor(config: Record<string, unknown>) {
      this.config = config;
      providerInstances.push(this);
    }
  },
}));

import { CollabSocketProvider } from '@web/data/yjs/collab-socket';
import { useSocket } from '@web/data/yjs/use-socket';
import { _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';

/** Wrap the hook in a CollabSocketProvider with the given userId (gate). */
function wrapper(userId?: string) {
  return function Wrapper({
    children,
  }: {
    children: React.ReactNode;
  }): React.JSX.Element {
    return (
      <CollabSocketProvider userId={userId}>{children}</CollabSocketProvider>
    );
  };
}

describe('useSocket — attach a doc to the shared socket via the manager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetCollabSocketForTests();
    wsInstances.length = 0;
    providerInstances.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('acquires a doc provider on the SHARED socket once userId is ready', () => {
    const doc = new Y.Doc();
    renderHook(() => useSocket({ name: 'project-p1/meta', doc }), {
      wrapper: wrapper('u1'),
    });
    expect(wsInstances).toHaveLength(1);
    expect(providerInstances).toHaveLength(1);
    const cfg = providerInstances[0]!.config;
    expect(cfg.websocketProvider).toBe(wsInstances[0]);
    expect(cfg.name).toBe('project-p1/meta');
    expect(cfg.document).toBe(doc);
    // A shared-websocketProvider provider does NOT auto-attach — the manager
    // must call attach() or the doc hangs in `connecting` forever (#A bug).
    expect(providerInstances[0]!.attach).toHaveBeenCalledOnce();
  });

  it('does NOT acquire while userId is absent (boot-race gate) — stays connecting', () => {
    const doc = new Y.Doc();
    const { result } = renderHook(
      () => useSocket({ name: 'project-p1/meta', doc }),
      { wrapper: wrapper(undefined) },
    );
    expect(providerInstances).toHaveLength(0);
    expect(result.current.status).toBe('connecting');
    expect(result.current.provider).toBeNull();
  });

  it('subscribes to the provider lifecycle events for the banner status', () => {
    const doc = new Y.Doc();
    renderHook(() => useSocket({ name: 'project-p1/meta', doc }), {
      wrapper: wrapper('u1'),
    });
    const events = providerInstances[0]!.on.mock.calls.map((c) => c[0]);
    expect(events).toContain('synced');
    expect(events).toContain('authenticationFailed');
    expect(events).toContain('close');
  });

  it('on unmount: releases the doc (deferred) but never closes the shared socket synchronously', () => {
    const doc = new Y.Doc();
    const { unmount } = renderHook(
      () => useSocket({ name: 'project-p1/meta', doc }),
      { wrapper: wrapper('u1') },
    );
    act(() => unmount());
    // Listeners removed immediately; teardown deferred.
    expect(providerInstances[0]!.off).toHaveBeenCalled();
    expect(providerInstances[0]!.destroy).not.toHaveBeenCalled();
    act(() => vi.runAllTimers());
    // Deferred teardown ran: doc detached, and (last doc) socket closed.
    expect(providerInstances[0]!.destroy).toHaveBeenCalledOnce();
    expect(wsInstances[0]!.destroy).toHaveBeenCalledOnce();
  });
});
