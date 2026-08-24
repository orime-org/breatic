// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
    emit: (event: string, payload?: unknown) => void;
    synced: boolean;
    isAuthenticated: boolean;
    authorizedScope: string | undefined;
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
    listeners: Record<string, Array<(payload?: unknown) => void>> = {};
    on = vi.fn((event: string, cb: (payload?: unknown) => void) => {
      (this.listeners[event] ??= []).push(cb);
    });
    off = vi.fn((event: string, cb: (payload?: unknown) => void) => {
      this.listeners[event] = (this.listeners[event] ?? []).filter(
        (f) => f !== cb,
      );
    });
    // Real event dispatch, so a test can drive the provider's lifecycle rather
    // than assert on which listeners were registered.
    emit(event: string, payload?: unknown): void {
      for (const cb of [...(this.listeners[event] ?? [])]) cb(payload);
    }
    synced = false;
    isAuthenticated = false;
    authorizedScope: string | undefined = undefined;
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

  it('hands the provider back on the very first render, with no round trip', () => {
    // The provider has to be RENDERED state, not a ref. Callers build things
    // out of it — an editor mounts its collaborator-caret layer only once it
    // exists — so its arrival has to re-render them. Held in a ref it did not,
    // and nothing else in the cold-acquire path did either: every setState in
    // that path writes the value it already holds, so React bails out and the
    // provider lands invisibly. Consumers then saw it only when some unrelated
    // render happened to read the ref — the first `synced` event a network
    // round-trip later, or a keystroke. That reads as "the editor takes a
    // moment to appear" online, and as never appearing at all offline.
    const doc = new Y.Doc();
    const { result } = renderHook(
      () => useSocket({ name: 'project-p1/document-s5', doc }),
      { wrapper: wrapper('u1') },
    );
    // No `synced`, no `authenticated`, nothing emitted at all.
    expect(result.current.provider).not.toBeNull();
    expect(result.current.provider).toBe(providerInstances[0]);
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

  it('remembers that the content arrived, across a consumer unmounting', () => {
    // "Has the real content ever arrived" is a fact about the DOCUMENT, and the
    // document outlives any one component: a project page holds a Space's doc
    // open for as long as its tab is open, while the body component that
    // renders it is remounted on every tab switch. Kept as component state the
    // latch resets on that remount, and the user is shown a loading placeholder
    // in front of content the local Y.Doc already holds.
    const doc = new Y.Doc();
    const name = 'project-p1/document-s1';
    // The tab-scoped keeper (SpaceDocSync's role) — holds a reference for as
    // long as the Space tab is open.
    renderHook(() => useSocket({ name, doc }), { wrapper: wrapper('u1') });
    // The body component (DocumentSpace's role) — remounted on a tab switch.
    const body = renderHook(() => useSocket({ name, doc }), {
      wrapper: wrapper('u1'),
    });

    act(() => {
      providerInstances[0]!.synced = true;
      providerInstances[0]!.emit('synced');
    });
    expect(body.result.current.hasEverSynced).toBe(true);

    // Switch to another Space tab and back. Only the body unmounts.
    act(() => body.unmount());
    act(() => vi.runAllTimers());
    const reopened = renderHook(() => useSocket({ name, doc }), {
      wrapper: wrapper('u1'),
    });

    expect(reopened.result.current.hasEverSynced).toBe(true);
    // And it is the same provider throughout — the keeper's reference stopped
    // the registry from tearing it down.
    expect(providerInstances).toHaveLength(1);
  });

  it('reports the latch even while the socket is down right now', () => {
    // The distinction the latch exists to draw: `synced` is false during any
    // routine close, but the content is already in the local Y.Doc, so the
    // editor must stay on screen.
    const doc = new Y.Doc();
    const name = 'project-p1/document-s2';
    const { result } = renderHook(() => useSocket({ name, doc }), {
      wrapper: wrapper('u1'),
    });

    act(() => {
      providerInstances[0]!.synced = true;
      providerInstances[0]!.emit('synced');
    });
    act(() => {
      providerInstances[0]!.synced = false;
      providerInstances[0]!.emit('close', { event: { code: 1006 } });
    });

    expect(result.current.synced).toBe(false);
    expect(result.current.status).toBe('disconnected');
    expect(result.current.hasEverSynced).toBe(true);
  });

  it('forgets once the document itself is torn down', () => {
    // Closing the Space tab releases the last reference; the provider and the
    // Y.Doc are both destroyed. What comes back on a reopen is a fresh
    // document whose content genuinely has not arrived yet, so the latch must
    // not survive — it is scoped to the document, not to the document's name.
    const doc = new Y.Doc();
    const name = 'project-p1/document-s3';
    const first = renderHook(() => useSocket({ name, doc }), {
      wrapper: wrapper('u1'),
    });
    act(() => {
      providerInstances[0]!.synced = true;
      providerInstances[0]!.emit('synced');
    });
    expect(first.result.current.hasEverSynced).toBe(true);

    act(() => first.unmount());
    act(() => vi.runAllTimers());
    expect(providerInstances[0]!.destroy).toHaveBeenCalledOnce();

    const reopened = renderHook(
      () => useSocket({ name, doc: new Y.Doc() }),
      { wrapper: wrapper('u1') },
    );
    expect(reopened.result.current.hasEverSynced).toBe(false);
  });

  it('remembers a refusal across a consumer unmounting, the way it remembers a sync', () => {
    // A rejection is a SETTLED FACT about the document, exactly like "the
    // content has arrived": the server refuses this document, leaves the shared
    // socket open, and never says it again — the handshake for this document
    // already happened and nothing will reconnect. So a component that mounts
    // afterwards has no way to learn it by listening.
    //
    // Kept only in component state, it dies on the first Space-tab switch, and
    // the body falls back to "Loading editor…" forever — the exact state the
    // unavailable screen exists to replace.
    const doc = new Y.Doc();
    const name = 'project-p1/document-refused';
    renderHook(() => useSocket({ name, doc }), { wrapper: wrapper('u1') });
    const body = renderHook(() => useSocket({ name, doc }), {
      wrapper: wrapper('u1'),
    });

    act(() =>
      providerInstances[0]!.emit('authenticationFailed', { reason: 'Forbidden' }),
    );
    expect(body.result.current.status).toBe('authFailed');

    act(() => body.unmount());
    act(() => vi.runAllTimers());
    const reopened = renderHook(() => useSocket({ name, doc }), {
      wrapper: wrapper('u1'),
    });

    expect(reopened.result.current.status).toBe('authFailed');
    expect(reopened.result.current.authFailedReason).toBe('Forbidden');
    // Refused means refused: a client that cannot authenticate cannot write.
    expect(reopened.result.current.writeAccess).toBe('denied');
  });

  it('lets a later successful handshake clear an earlier refusal', () => {
    // A refusal is NOT monotonic, unlike "the content has arrived". The Space
    // is restored, the member is re-added, an infra blip passes — and the next
    // reconnect authenticates fine. Verified in the library: `onOpen()` sets
    // `isAuthenticated = false` and re-sends the token on EVERY socket open,
    // so both outcomes are per-handshake, not per-document-lifetime.
    //
    // Treated as permanent, a document that has recovered is dragged back into
    // "refused" by the first Space-tab switch, with no way out but a full page
    // reload.
    const doc = new Y.Doc();
    const name = 'project-p1/document-recovered';
    renderHook(() => useSocket({ name, doc }), { wrapper: wrapper('u1') });
    const body = renderHook(() => useSocket({ name, doc }), {
      wrapper: wrapper('u1'),
    });

    act(() =>
      providerInstances[0]!.emit('authenticationFailed', { reason: 'Forbidden' }),
    );
    expect(body.result.current.status).toBe('authFailed');

    // The situation reverses and the socket reconnects.
    act(() => {
      providerInstances[0]!.isAuthenticated = true;
      providerInstances[0]!.authorizedScope = 'read-write';
      providerInstances[0]!.emit('authenticated', { scope: 'read-write' });
      providerInstances[0]!.synced = true;
      providerInstances[0]!.emit('synced');
    });
    expect(body.result.current.status).toBe('connected');

    // Switch Space tab away and back.
    act(() => body.unmount());
    act(() => vi.runAllTimers());
    const reopened = renderHook(() => useSocket({ name, doc }), {
      wrapper: wrapper('u1'),
    });

    expect(reopened.result.current.status).toBe('connected');
    expect(reopened.result.current.authFailedReason).toBeNull();
    expect(reopened.result.current.writeAccess).toBe('granted');
  });

  it('treats a refusal as losing write access, not as unchanged', () => {
    // `writeAccess` is what the editor reads to decide whether typing is
    // pointless. A refusal is the strongest possible form of "your updates go
    // nowhere", so leaving it at whatever it was before — `granted`, for a
    // document that had authenticated fine until the Space was deleted — hands
    // the user a live editor over a dead connection.
    const doc = new Y.Doc();
    const { result } = renderHook(
      () => useSocket({ name: 'project-p1/document-revoked', doc }),
      { wrapper: wrapper('u1') },
    );
    act(() =>
      providerInstances[0]!.emit('authenticated', { scope: 'read-write' }),
    );
    expect(result.current.writeAccess).toBe('granted');

    act(() =>
      providerInstances[0]!.emit('authenticationFailed', { reason: 'Forbidden' }),
    );
    expect(result.current.writeAccess).toBe('denied');
  });

  it('re-reads the granted scope on acquire, for a provider that authenticated earlier', () => {
    // The path every Space-tab switch takes. `authenticated` fires once per
    // handshake, so a component mounting onto an already-authenticated shared
    // provider never hears it — it has to ask. Without the ask it would start
    // at `unknown`, and a capped member would get a live editor back on every
    // tab switch until the next reconnect.
    const doc = new Y.Doc();
    const name = 'project-p1/document-scope-reread';
    renderHook(() => useSocket({ name, doc }), { wrapper: wrapper('u1') });
    act(() => {
      providerInstances[0]!.isAuthenticated = true;
      providerInstances[0]!.authorizedScope = 'readonly';
      providerInstances[0]!.emit('authenticated', { scope: 'readonly' });
    });

    const late = renderHook(() => useSocket({ name, doc }), {
      wrapper: wrapper('u1'),
    });
    expect(late.result.current.writeAccess).toBe('denied');
  });

  it('reports the write access the server granted, not the one we assumed', () => {
    // The server decides per connection whether it may write: a viewer, or an
    // otherwise-writable member who is over the per-document connection cap,
    // is authenticated with a read-only scope. It says so on the wire
    // (`writeAuthenticated(readOnly)` → "readonly" / "read-write"). Dropping
    // that leaves a client rendering a live editor whose every update the
    // server discards without an error — in a text editor, a whole document
    // typed and lost with nothing on screen to hint at it.
    const doc = new Y.Doc();
    const { result } = renderHook(
      () => useSocket({ name: 'project-p1/document-s4', doc }),
      { wrapper: wrapper('u1') },
    );
    // Nothing claimed either way until the server has answered.
    expect(result.current.writeAccess).toBe('unknown');

    act(() => providerInstances[0]!.emit('authenticated', { scope: 'readonly' }));
    expect(result.current.writeAccess).toBe('denied');

    act(() =>
      providerInstances[0]!.emit('authenticated', { scope: 'read-write' }),
    );
    expect(result.current.writeAccess).toBe('granted');
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
