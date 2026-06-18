// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { HocuspocusProvider } from '@hocuspocus/provider';
import * as React from 'react';
import type * as Y from 'yjs';
import { reportCollabFailure } from '@web/data/yjs/collab-failure-report';
import {
  acquireDocProvider,
  releaseDocProvider,
  useCollabSocketContext,
} from '@web/data/yjs/collab-socket';

interface UseSocketOptions {
  /** Document name (e.g. `project-abc/meta`). */
  name: string;
  /** The Y.Doc to bind to the provider. */
  doc: Y.Doc;
}

/**
 * High-level connection lifecycle state derived from raw Hocuspocus
 * provider events. Surfaced via {@link SocketState.status} so UI can
 * render a `ConnectionBanner` without each consumer re-deriving the
 * state machine from `synced` + ws events.
 *
 *   connecting  — initial dial OR reconnect attempt in flight
 *   connected   — auth passed + first sync landed (steady-state happy)
 *   authFailed  — server rejected token / membership (4401 / 4403)
 *   disconnected — ws dropped for non-auth reason (network / server crash)
 */
export type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'authFailed'
  | 'disconnected';

interface SocketState {
  /** The active provider (null until first connect). */
  provider: HocuspocusProvider | null;
  /** True once the provider has synced with the server at least once. */
  synced: boolean;
  /** High-level connection lifecycle for banner UI. */
  status: ConnectionStatus;
  /**
   * If `status === 'authFailed'`, the server-provided reason string
   * (e.g. `"Forbidden"`). Used by future ErrorState code to discriminate
   * 401 (re-login) vs 403 (request-access) without re-introspection.
   */
  authFailedReason: string | null;
}

/**
 * Subscribe a component to one Yjs document's connection on the SHARED collab
 * socket. The provider + socket themselves live in the module-level
 * reference-counted registry (see `collab-socket`); this hook only
 * acquires / releases the document and mirrors its connection lifecycle into
 * React state for the banner UI.
 *
 * Gated on the shared-socket readiness (`useCollabSocketContext().ready`, which
 * is the userId gate — the #1381 boot-race fix): until a session is resolved no
 * document is acquired and the hook stays `connecting`.
 *
 * StrictMode-safe by construction: the registry's deferred reference-counted
 * teardown means this hook's mount→unmount→mount in StrictMode does NOT detach
 * the document or re-auth it (which would trip a duplicate-auth "Forbidden").
 * Here we only add / remove event listeners, which is side-effect-free on the
 * shared provider.
 * @param root0 - Socket binding options.
 * @param root0.name - Document name to attach (e.g. `project-abc/meta`).
 * @param root0.doc - The Y.Doc instance to bind to the provider.
 * @returns The live provider plus sync flag, connection status, and any auth-failure reason.
 */
export function useSocket({ name, doc }: UseSocketOptions): SocketState {
  const { ready, url } = useCollabSocketContext();
  const [synced, setSynced] = React.useState(false);
  const [status, setStatus] = React.useState<ConnectionStatus>('connecting');
  const [authFailedReason, setAuthFailedReason] = React.useState<
    string | null
  >(null);
  const providerRef = React.useRef<HocuspocusProvider | null>(null);

  React.useEffect(() => {
    // Gated: the shared socket may not be dialed until userId resolves. Acquire
    // nothing and stay `connecting`; the context re-renders `ready` once userId
    // lands, re-running this effect to acquire.
    if (!ready) {
      setStatus('connecting');
      setSynced(false);
      setAuthFailedReason(null);
      providerRef.current = null;
      return;
    }

    const provider = acquireDocProvider(name, doc, url);
    providerRef.current = provider;

    // Initialise from the provider's CURRENT state — acquiring an already-synced
    // shared provider won't re-emit `synced`.
    if (provider.synced) {
      setSynced(true);
      setStatus('connected');
    } else {
      setSynced(false);
      setStatus('connecting');
    }
    setAuthFailedReason(null);

    /**
     * First sync landed → steady-state happy.
     */
    const onSynced = (): void => {
      setSynced(true);
      setStatus('connected');
    };
    /**
     * Server rejected token / membership → surface a sticky auth banner.
     * @param data - Auth-failure payload carrying the server reason.
     */
    const onAuthFailed = (data: { reason?: string } | undefined): void => {
      const reason = data?.reason ?? 'unknown';
      setStatus('authFailed');
      setAuthFailedReason(reason);
      // Always report — an auth rejection is a genuine failure (the
      // stuck-banner bug). console for dev, Sentry for prod oncall.
      reportCollabFailure({ kind: 'auth', docName: name, reason });
    };
    /**
     * Socket closed for a non-auth reason → soft disconnect (auto-reconnects).
     * @param data - Close payload carrying the WebSocket close code.
     */
    const onClose = (data: { event?: { code?: number } } | undefined): void => {
      // 4401 / 4403 means auth was rejected — `authenticationFailed` has
      // already moved us to `authFailed`; don't downgrade to `disconnected`
      // here or the banner would mask the real cause.
      const code = data?.event?.code;
      if (code === 4401 || code === 4403) return;
      // Keep an existing authFailed sticky across the close that follows it.
      // For everything else, surface a soft disconnect (the shared socket
      // auto-reconnects and re-syncs every attached doc).
      setSynced(false);
      setStatus((prev) => (prev === 'authFailed' ? prev : 'disconnected'));
      reportCollabFailure({ kind: 'disconnect', docName: name, code });
    };

    provider.on('synced', onSynced);
    provider.on('authenticationFailed', onAuthFailed);
    provider.on('close', onClose);

    return () => {
      // Remove our listeners BEFORE releasing — so the deferred teardown's
      // destroy() close never reaches this hook (no false disconnect report).
      provider.off('synced', onSynced);
      provider.off('authenticationFailed', onAuthFailed);
      provider.off('close', onClose);
      providerRef.current = null;
      releaseDocProvider(name);
      setSynced(false);
      setStatus('connecting');
      setAuthFailedReason(null);
    };
  }, [ready, name, doc, url]);

  return {
    provider: providerRef.current,
    synced,
    status,
    authFailedReason,
  };
}
