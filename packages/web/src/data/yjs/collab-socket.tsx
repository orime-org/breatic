// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from '@hocuspocus/provider';
import * as React from 'react';
import type * as Y from 'yjs';

/**
 * Placeholder token the Hocuspocus client must send purely to trip the
 * server's `onAuthenticate` hook — without ANY token the client-side library
 * short-circuits and the hook is never invoked (ueberdosis/hocuspocus#596). The
 * server ignores it and reads the real session token from the httpOnly
 * `breatic_session` cookie on the same-origin `/ws` upgrade request.
 */
const COOKIE_AUTH_PLACEHOLDER = '__cookie_auth__';

/** Default same-origin path to the Hocuspocus server. */
const COLLAB_WS_PATH = '/ws';

/**
 * Build an absolute `ws(s)://` URL from a same-origin path, or pass an
 * already-absolute `ws`/`wss` URL straight through.
 * @param url - Either an absolute `ws(s)://…` URL or a same-origin path like `/ws`.
 * @returns The absolute WebSocket URL to dial.
 */
function toAbsoluteWsUrl(url: string): string {
  if (url.startsWith('ws')) return url;
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.host}${url}`;
}

// ───────────────────────── module-level shared socket ─────────────────────────
//
// ONE shared WebSocket for the whole tab, plus ONE HocuspocusProvider per
// document, both reference-counted with DEFERRED teardown. This is the
// `getDoc`-cache pattern applied to the transport: a single source of truth that
// every consumer shares, surviving React 18 StrictMode's synchronous
// mount→unmount→mount.
//
// Why deferred teardown: StrictMode runs each effect setup → cleanup → setup on
// mount. A naive "destroy on cleanup" would detach the document on the cleanup
// and re-attach it on the second setup — and that detach (CloseMessage) racing
// the re-attach (auth token) makes the server reject the re-auth as a duplicate
// ("Forbidden"), which sticks the connection banner (the 2026-06-18 bug). By
// scheduling the teardown on a macrotask and cancelling it when the resource is
// re-acquired, the StrictMode 1→0→1 refcount oscillation tears nothing down, so
// the document never detaches and never re-auths. Real unmounts (tab close /
// leave project) settle to refcount 0 and the deferred teardown fires.

interface DocEntry {
  provider: HocuspocusProvider;
  refcount: number;
  pendingRelease: ReturnType<typeof setTimeout> | null;
}

let sharedSocket: HocuspocusProviderWebsocket | null = null;
const docEntries = new Map<string, DocEntry>();

/**
 * Get-or-create the shared WebSocket. Lazily created on the first document
 * acquisition (never before — so the userId gate, enforced by callers, keeps it
 * closed until a session is resolved).
 * @param url - WebSocket URL or same-origin path to the Hocuspocus server.
 * @returns The single shared WebSocket for the tab.
 */
function ensureSharedSocket(url: string): HocuspocusProviderWebsocket {
  if (!sharedSocket) {
    sharedSocket = new HocuspocusProviderWebsocket({ url: toAbsoluteWsUrl(url) });
  }
  return sharedSocket;
}

/**
 * Destroy the shared WebSocket once no documents remain attached.
 */
function maybeDestroySharedSocket(): void {
  if (docEntries.size === 0 && sharedSocket) {
    sharedSocket.destroy();
    sharedSocket = null;
  }
}

/**
 * Acquire the shared HocuspocusProvider for a document, attaching it to the
 * shared socket on first use and bumping its reference count. A pending deferred
 * release is cancelled so a StrictMode re-mount reuses the live provider instead
 * of churning it.
 *
 * The provider is created with a placeholder token only (the real session rides
 * the cookie). Per-consumer connection state is observed via `provider.on(...)`
 * in `useSocket`, not via construction callbacks, so the shared provider stays
 * consumer-agnostic.
 * @param name - Document name (e.g. `project-abc/meta`).
 * @param doc - The Y.Doc to bind to the provider.
 * @param url - WebSocket URL or same-origin path to the Hocuspocus server.
 * @returns The shared provider for the document.
 */
export function acquireDocProvider(
  name: string,
  doc: Y.Doc,
  url: string = COLLAB_WS_PATH,
): HocuspocusProvider {
  const existing = docEntries.get(name);
  if (existing) {
    if (existing.pendingRelease !== null) {
      clearTimeout(existing.pendingRelease);
      existing.pendingRelease = null;
    }
    existing.refcount += 1;
    return existing.provider;
  }
  const websocketProvider = ensureSharedSocket(url);
  const provider = new HocuspocusProvider({
    websocketProvider,
    name,
    document: doc,
    token: COOKIE_AUTH_PLACEHOLDER,
  });
  // A shared-websocketProvider provider does NOT auto-attach (its constructor
  // only auto-attaches when it manages its own socket). Attach explicitly or it
  // never registers / sends its token and hangs in `connecting` forever.
  provider.attach();
  docEntries.set(name, { provider, refcount: 1, pendingRelease: null });
  return provider;
}

/**
 * Release a document provider. Decrements its reference count; on reaching zero
 * it schedules a DEFERRED teardown (cancellable by a re-acquire, which is how
 * StrictMode re-mounts avoid churn). A real teardown detaches the document from
 * the shared socket — without closing the socket — and closes the socket only
 * once the last document is gone.
 * @param name - Document name previously passed to {@link acquireDocProvider}.
 */
export function releaseDocProvider(name: string): void {
  const entry = docEntries.get(name);
  if (!entry) return;
  entry.refcount -= 1;
  if (entry.refcount > 0) return;
  entry.pendingRelease = setTimeout(() => {
    // detaches from the shared socket (CloseMessage + providerMap removal);
    // does NOT close the shared socket (manageSocket is false).
    entry.provider.destroy();
    docEntries.delete(name);
    maybeDestroySharedSocket();
  }, 0);
}

/**
 * Test-only: synchronously tear down the shared socket + all document providers
 * and clear pending releases. Not for production use.
 */
export function _resetCollabSocketForTests(): void {
  docEntries.forEach((entry) => {
    if (entry.pendingRelease !== null) clearTimeout(entry.pendingRelease);
    entry.provider.destroy();
  });
  docEntries.clear();
  if (sharedSocket) {
    sharedSocket.destroy();
    sharedSocket = null;
  }
}

// ───────────────────────── userId gate (React context) ─────────────────────────

interface CollabSocketContextValue {
  /** Whether the shared socket may be dialed (userId resolved). */
  ready: boolean;
  /** WebSocket URL or same-origin path. */
  url: string;
}

const CollabSocketContext = React.createContext<CollabSocketContextValue>({
  ready: false,
  url: COLLAB_WS_PATH,
});

interface CollabSocketProviderProps {
  /**
   * Current user id from AuthBootstrap. No document is attached (and so the
   * shared socket is never dialed) until this is set — the #1381 boot-race gate:
   * dialing before `/auth/me` resolves the session cookie sticks the connection
   * on `authFailed` forever (the PR #154 fix wiped by the v14 reset, restored
   * here once at the gate instead of per-doc).
   */
  userId?: string;
  /** WebSocket URL or same-origin path; defaults to `/ws`. */
  url?: string;
  children: React.ReactNode;
}

/**
 * Gates the shared collab socket on `userId` for the whole project subtree.
 * Holds no socket itself — the socket + per-document providers live in the
 * module-level reference-counted registry above; this only signals readiness so
 * `useSocket` knows when it may acquire a document.
 * @param root0 - Provider props.
 * @param root0.userId - Current user id; documents are not attached until this is set.
 * @param root0.url - WebSocket URL or same-origin path; defaults to `/ws`.
 * @param root0.children - Subtree whose document hooks share the socket.
 * @returns The context provider wrapping the project subtree.
 */
export function CollabSocketProvider({
  userId,
  url = COLLAB_WS_PATH,
  children,
}: CollabSocketProviderProps): React.JSX.Element {
  const value = React.useMemo<CollabSocketContextValue>(
    () => ({ ready: Boolean(userId), url }),
    [userId, url],
  );
  return (
    <CollabSocketContext.Provider value={value}>
      {children}
    </CollabSocketContext.Provider>
  );
}

/**
 * Read the shared-socket gate state from context.
 * @returns Whether the socket may be dialed (userId ready) and the socket URL.
 */
export function useCollabSocketContext(): CollabSocketContextValue {
  return React.useContext(CollabSocketContext);
}
