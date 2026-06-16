// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { HocuspocusProvider } from '@hocuspocus/provider';
import * as React from 'react';
import * as Y from 'yjs';
import { reportCollabFailure } from '@web/data/yjs/collab-failure-report';

/**
 * Placeholder token the Hocuspocus client must send purely to
 * trip the server's `onAuthenticate` hook — without ANY token the
 * client-side library short-circuits and the hook is never invoked
 * (see ueberdosis/hocuspocus#596). The server ignores this string
 * and reads the real session token from the httpOnly `breatic_session`
 * cookie attached to the WebSocket upgrade request (the browser
 * sends the cookie automatically because the WS endpoint is
 * same-origin under `/ws`).
 */
const COOKIE_AUTH_PLACEHOLDER = '__cookie_auth__';

interface UseSocketOptions {
  /** Document name (e.g. `project-abc/meta`). */
  name: string;
  /** The Y.Doc to bind to the provider. */
  doc: Y.Doc;
  /** WebSocket URL to the Hocuspocus server. */
  url?: string;
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
 * StrictMode-safe Hocuspocus provider hook.
 *
 * CRITICAL: `new HocuspocusProvider()` opens a WebSocket. In React 18
 * StrictMode, every `useEffect` runs twice on mount in dev — so naive
 * `useMemo(() => new Provider(), [])` + separate cleanup leaks one
 * socket per mount. The cleanup runs against the FIRST instance, but
 * the second instance (created by the second mount) is never closed.
 *
 * The safe pattern: ALWAYS create the provider + register cleanup
 * inside the SAME `useEffect`. React guarantees cleanup runs before
 * the next effect, so the first socket is properly destroyed before
 * the second is created.
 *
 * (Lesson from PR #99 — see memory `feedback_strictmode_resource_hook`.)
 * @param root0 - Socket binding options.
 * @param root0.name - Document name to open on the Hocuspocus server (e.g. `project-abc/meta`).
 * @param root0.doc - The Y.Doc instance to bind to the provider.
 * @param root0.url - WebSocket URL or path to the Hocuspocus server; defaults to `/ws`.
 * @returns The live provider plus sync flag, connection status, and any auth-failure reason.
 */
export function useSocket({
  name,
  doc,
  url = '/ws',
}: UseSocketOptions): SocketState {
  const [synced, setSynced] = React.useState(false);
  const [status, setStatus] = React.useState<ConnectionStatus>('connecting');
  const [authFailedReason, setAuthFailedReason] = React.useState<
    string | null
  >(null);
  const providerRef = React.useRef<HocuspocusProvider | null>(null);

  React.useEffect(() => {
    // Per-run flag so this provider's own teardown close (unmount / doc
    // swap) isn't mis-reported as a connection failure. Captured in the
    // effect closure (not a ref) so the async onClose that fires AFTER
    // destroy() reads THIS run's value — immune to a re-mount resetting it.
    let closing = false;

    // Reset state on (re)mount so a doc swap starts from a clean
    // lifecycle, not a stale `connected` / `authFailed`.
    setStatus('connecting');
    setSynced(false);
    setAuthFailedReason(null);

    const fullUrl = url.startsWith('ws')
      ? url
      : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}${url}`;

    const provider = new HocuspocusProvider({
      url: fullUrl,
      name,
      document: doc,
      token: COOKIE_AUTH_PLACEHOLDER,
      onSynced: () => {
        setSynced(true);
        setStatus('connected');
      },
      onAuthenticationFailed: (data: { reason?: string } | undefined) => {
        const reason = data?.reason ?? 'unknown';
        setStatus('authFailed');
        setAuthFailedReason(reason);
        // Always report — an auth rejection is a genuine failure (the
        // stuck-banner bug). console for dev, Sentry for prod oncall.
        reportCollabFailure({ kind: 'auth', docName: name, reason });
      },
      onClose: (data: { event?: { code?: number } } | undefined) => {
        // 4401 / 4403 means auth was rejected — `onAuthenticationFailed`
        // has already moved us to `authFailed`; don't downgrade to
        // `disconnected` here or the banner would mask the real cause.
        const code = data?.event?.code;
        if (code === 4401 || code === 4403) return;
        // Keep an existing authFailed sticky across the close that
        // follows it. For everything else, surface a soft disconnect.
        setSynced(false);
        setStatus((prev) => (prev === 'authFailed' ? prev : 'disconnected'));
        // Report genuine drops (network / server crash) — but NOT our own
        // teardown close, which sets `closing` in the cleanup below.
        if (!closing) {
          reportCollabFailure({ kind: 'disconnect', docName: name, code });
        }
      },
    });
    providerRef.current = provider;

    return () => {
      closing = true;
      provider.destroy();
      providerRef.current = null;
      setSynced(false);
      setStatus('connecting');
      setAuthFailedReason(null);
    };
    // Doc / name change implies a new document binding so also
    // re-create the provider. Auth lives in the cookie now and
    // rotates server-side, so there is no `token` dependency to
    // tear the socket down on.
  }, [name, doc, url]);

  return {
    provider: providerRef.current,
    synced,
    status,
    authFailedReason,
  };
}
