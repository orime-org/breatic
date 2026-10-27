// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from '@hocuspocus/provider';
import * as React from 'react';
import type * as Y from 'yjs';

import { COLLAB_REAUTH_REASONS, isReauthCloseReason, parseDocName } from '@breatic/shared';
import { reportCollabFailure } from '@web/data/yjs/collab-failure-report';
import { destroyDoc } from '@web/data/yjs/manager';
import { bindDocSync, type DocSyncBinding } from '@web/data/yjs/doc-sync-binding';

/**
 * Placeholder token the Hocuspocus client must send purely to trip the
 * server's `onAuthenticate` hook — without ANY token the client-side library
 * short-circuits and the hook is never invoked (ueberdosis/hocuspocus#596). The
 * server ignores it and reads the real session token from the httpOnly
 * session cookie on the configured backend WebSocket upgrade request.
 */
const COOKIE_AUTH_PLACEHOLDER = '__cookie_auth__';

/** Default same-origin path to the Hocuspocus server. */
const COLLAB_WS_PATH = import.meta.env.VITE_COLLAB_URL?.trim() || '/ws';

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

/**
 * What is currently true of a document, for a component that was not there to
 * hear it.
 *
 * The provider announces these once per event and never repeats them. A
 * component that mounts afterwards cannot learn them by listening, and one
 * can mount at any time: a Space tab holds a document open, not the body that
 * renders it, and that body can unmount and mount again while the document
 * stays open. Kept in component state they
 * are silently forgotten there — which is how a loading placeholder came to be
 * shown in front of content already in memory, and how a refused document came
 * to revert to that same placeholder with no explanation.
 *
 * So they live with the DOCUMENT. They die with the provider and the Y.Doc:
 * what comes back after a real teardown is a fresh document that knows nothing.
 *
 * **These two are NOT the same kind of fact, and the difference matters.**
 * `hasEverSynced` only ever goes from false to true. `authFailure` moves both
 * ways: the provider re-authenticates on EVERY socket open (`onOpen` sets
 * `isAuthenticated = false` and re-sends the token), so a Space that is
 * restored, a member who is re-added, or an infra blip that passes all produce
 * a later handshake that succeeds. Treating the refusal as permanent dragged a
 * recovered document back into "refused" on the next tab switch, with no way
 * out but a page reload.
 */
export interface DocFacts {
  /**
   * Whether the content has arrived at least once — monotonic. Unlike
   * `provider.synced`, which answers "in sync right now" and drops to false on
   * every routine close (a wifi switch, a laptop waking, a collab redeploy).
   * Once the content is in, the local Y.Doc holds it and offline edits merge
   * cleanly on reconnect.
   */
  hasEverSynced: boolean;
  /**
   * The server's reason for refusing this document, or null if the last
   * handshake was accepted — NOT monotonic, see above. Refusal is per-document
   * in Hocuspocus: the shared socket stays open and every sibling document
   * stays healthy, which is why nothing else surfaces it.
   */
  authFailure: string | null;
  /**
   * Whether the session this tab connects with has ended (signed out
   * elsewhere, a password reset; inner#1548). The refusals that follow are
   * expected, so they are not reported as failures. One cookie serves every
   * document of the tab, so this is held once for the shared socket: set by a
   * "Session ended" close on any document, cleared by any successful
   * handshake. A document opened afterwards, which never gets that close,
   * reads it too.
   */
  sessionEnded: boolean;
}

interface DocEntry {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  refcount: number;
  pendingRelease: ReturnType<typeof setTimeout> | null;
  facts: Omit<DocFacts, 'sessionEnded'>;
  sync: DocSyncBinding | null;
}

let sharedSocket: HocuspocusProviderWebsocket | null = null;
const docEntries = new Map<string, DocEntry>();
const providerObservers = new Map<string, Set<() => void>>();
const projectSyncObservers = new Map<string, Set<() => void>>();
let sessionEnded = false;
let boundAccount: string | undefined;

/**
 * Reads unsynced edits across the Project's open Canvas and Document entries.
 * @param projectId - Canonical Project identifier.
 * @returns Whether a registered content document has unconfirmed edits.
 * @throws {never} Never.
 */
export function hasProjectUnsyncedEdits(projectId: string): boolean {
  for (const [name, entry] of docEntries) {
    if (parseDocName(name)?.projectId === projectId && entry.sync?.hasUnsyncedEdits()) return true;
  }
  return false;
}

/**
 * Observes the Project's derived risk without acquiring document references.
 * @param projectId - Canonical Project identifier.
 * @param listener - Called when a contributing entry's risk changes.
 * @returns The subscription cleanup.
 * @throws {never} Never.
 */
export function subscribeProjectSync(projectId: string, listener: () => void): () => void {
  const listeners = projectSyncObservers.get(projectId) ?? new Set<() => void>();
  listeners.add(listener);
  projectSyncObservers.set(projectId, listeners);
  return (): void => {
    listeners.delete(listener);
    if (listeners.size === 0) projectSyncObservers.delete(projectId);
  };
}

/**
 * Publishes a changed document contribution to its Project observers.
 * @param projectId - Canonical Project identifier.
 * @throws {never} Never.
 */
function notifyProjectSync(projectId: string): void {
  projectSyncObservers.get(projectId)?.forEach((listener) => listener());
}

/**
 * Renders from the same version facts read by event-time leave checks.
 * @param projectId - Canonical Project identifier.
 * @returns Whether local content edits await confirmation.
 * @throws {never} Never.
 */
export function useProjectUnsyncedEdits(projectId: string): boolean {
  const subscribe = React.useCallback((listener: () => void): (() => void) => subscribeProjectSync(projectId, listener), [projectId]);
  const read = React.useCallback((): boolean => hasProjectUnsyncedEdits(projectId), [projectId]);
  return React.useSyncExternalStore(subscribe, read);
}

/**
 * Read the existing connection without retaining it.
 * @param name - Canonical document name.
 * @returns The registered provider, or null.
 * @throws {never} Never.
 */
export function readDocProvider(name: string): HocuspocusProvider | null {
  return docEntries.get(name)?.provider ?? null;
}

/**
 * Observe connection identity while its original owner manages it.
 * @param name - Canonical document name.
 * @param listener - Called when the provider changes.
 * @returns The observer cleanup.
 * @throws {never} Never.
 */
export function subscribeDocProvider(name: string, listener: () => void): () => void {
  let listeners = providerObservers.get(name);
  if (!listeners) {
    listeners = new Set();
    providerObservers.set(name, listeners);
  }
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
    if (listeners.size === 0) providerObservers.delete(name);
  };
}

/**
 * Publish a change to the provider stored for one document.
 * @param name - Canonical document name.
 * @throws {never} Never.
 */
function notifyDocProvider(name: string): void {
  providerObservers.get(name)?.forEach((listener) => listener());
}

/**
 * Follow an existing provider without opening a connection.
 * @param name - Canonical document name, or null to observe none.
 * @returns The registered provider, or null.
 * @throws {never} Never.
 */
export function useDocProvider(name: string | null): HocuspocusProvider | null {
  const subscribe = React.useCallback((listener: () => void): (() => void) =>
    name === null ? (): void => undefined : subscribeDocProvider(name, listener), [name]);
  const read = React.useCallback((): HocuspocusProvider | null =>
    name === null ? null : readDocProvider(name), [name]);
  return React.useSyncExternalStore(subscribe, read);
}

/**
 * Release one provider before asking the document manager to release its data.
 * @param name - Canonical wire name.
 * @param entry - The exact provider/document pair being retired.
 */
function destroyDocEntry(name: string, entry: DocEntry): void {
  if (entry.pendingRelease !== null) clearTimeout(entry.pendingRelease);
  if (docEntries.get(name) === entry) docEntries.delete(name);
  entry.sync?.dispose();
  entry.provider.destroy();
  destroyDoc(name, entry.doc);
  const projectId = parseDocName(name)?.projectId;
  if (projectId) notifyProjectSync(projectId);
  notifyDocProvider(name);
}

/** Release the previous account's transports and their document-scoped state. */
function destroyAccountTransport(): void {
  const entries = [...docEntries];
  // Retired provider callbacks must not mutate the current registry or session facts.
  docEntries.clear();
  entries.forEach(([name, entry]) => destroyDocEntry(name, entry));
  sessionEnded = false;
  if (sharedSocket) {
    sharedSocket.destroy();
    sharedSocket = null;
  }
}

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
    // The connection reports its own drops: each attached provider re-emits
    // this close, so reporting there sent one alert per open document. Only a
    // connection that had opened counts as dropped; while it is down every
    // failed reconnect attempt closes too, and those belong to the same drop.
    let opened = false;
    sharedSocket.on('open', () => {
      opened = true;
    });
    sharedSocket.on('close', (data: { event?: { code?: number; reason?: string } } | undefined) => {
      if (!opened) return;
      opened = false;
      // Every document refused (session ended, member removed): nothing is
      // sent any more and the provider drops the idle connection every 30 s.
      // That drop is the expected end state, not a failure.
      if ([...docEntries.values()].every((e) => e.facts.authFailure !== null)) return;
      reportCollabFailure({
        kind: 'disconnect',
        code: data?.event?.code,
        reason: data?.event?.reason || undefined,
        documents: docEntries.size,
      });
    });
  }
  return sharedSocket;
}

/**
 * Put every provider's awareness state back after the browser restores a page
 * it had put aside.
 *
 * The browser's contract for a page that gets cached and restored has two
 * halves: tear down in `pagehide`, set back up in `pageshow`. The collaboration
 * provider does the first half for us — its own `pagehide` handler removes this
 * client's awareness state — and leaves the second to the application. Without
 * it, that state stays removed for the rest of the page's life, and two things
 * quietly stop working:
 *
 *   - The heartbeat. y-protocols renews the local clock only
 *     `if (this.getLocalState() !== null)`, so the timer keeps firing and keeps
 *     doing nothing. The server sees somebody connected but silent and the
 *     presence sweep turns them off — for good, since coming back needs a beat.
 *   - The caret. `setLocalStateField` is a no-op on a null state, and that is
 *     the only way this client publishes its cursor and focus.
 *
 * Restoring is a one-liner because of where the state comes from: the
 * `Awareness` constructor's last line sets it to `{}` and nothing else ever
 * does. A restored page brings the whole JavaScript context back as it was, so
 * that line does not run again — and reconnecting only restores the socket, not
 * the state that decides whether anything travels over it. Setting `{}` is
 * exactly what construction did; the cursor and focus fields are republished by
 * the editors on the next selection or focus change.
 */
function restoreAwarenessAfterPageRestore(): void {
  docEntries.forEach((entry) => {
    const { awareness } = entry.provider;
    // Only when it is actually missing. A live state holds this client's
    // current cursor and focus, and overwriting it would throw those away.
    if (awareness && awareness.getLocalState() === null) {
      awareness.setLocalState({});
    }
  });
}

// Registered once, for the tab, next to the registry it repairs — the same
// place the providers live, so a new document is covered by construction rather
// than by remembering to wire something. Guarded for non-browser environments
// the way the provider library guards its own listener.
if (typeof window !== 'undefined' && 'addEventListener' in window) {
  window.addEventListener('pageshow', (event) => {
    // `persisted` false is an ordinary load: nothing was torn down, and there
    // is nothing to put back.
    if ((event).persisted) {
      restoreAwarenessAfterPageRestore();
    }
  });
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
  if (existing?.doc === doc) {
    if (existing.pendingRelease !== null) {
      clearTimeout(existing.pendingRelease);
      existing.pendingRelease = null;
    }
    existing.refcount += 1;
    return existing.provider;
  }
  if (existing) destroyDocEntry(name, existing);
  const websocketProvider = ensureSharedSocket(url);
  const provider = new HocuspocusProvider({
    websocketProvider,
    name,
    document: doc,
    token: COOKIE_AUTH_PLACEHOLDER,
  });
  const entry: DocEntry = {
    doc,
    provider,
    refcount: 1,
    pendingRelease: null,
    facts: { hasEverSynced: false, authFailure: null },
    sync: null,
  };
  const parsed = parseDocName(name);
  if (parsed?.kind === 'canvas' || parsed?.kind === 'document') {
    entry.sync = bindDocSync(name, doc, provider, () => notifyProjectSync(parsed.projectId));
  }
  docEntries.set(name, entry);
  // The registry watches for these itself rather than letting a consumer report
  // them: consumers come and go, and the one that happens to be mounted when
  // the server answers is not necessarily the one that needs to know later.
  // Subscribed before `attach` so nothing can precede them.
  provider.on('synced', () => {
    if (docEntries.get(name) !== entry) return;
    entry.facts.hasEverSynced = true;
  });
  provider.on('authenticationFailed', (data: { reason?: string } | undefined) => {
    if (docEntries.get(name) !== entry) return;
    entry.facts.authFailure = data?.reason ?? 'unknown';
  });
  // The other direction. Without it a refusal is permanent even after the
  // server has started accepting this document again.
  provider.on('authenticated', () => {
    if (docEntries.get(name) !== entry) return;
    entry.facts.authFailure = null;
    sessionEnded = false;
  });
  // Collab closed this one document so the server can answer again with a
  // changed scope (archived, restored, role changed, content replaced). Only
  // the document closed; the shared socket is still open, so nothing would
  // ever re-send the token and the document would sit disconnected. Re-run
  // the provider's own open step on the same socket: token, then sync.
  // Not `detach()` + `attach()`: detaching sends a CLOSE of its own, which the
  // server queues and then applies to the fresh connection right behind it.
  // When the socket itself is down there is no open payload, and the socket's
  // reconnect re-opens every attached document anyway.
  provider.on('close', (data: { event?: { reason?: string } } | undefined) => {
    if (docEntries.get(name) !== entry) return;
    if (data?.event?.reason === COLLAB_REAUTH_REASONS.sessionEnded) sessionEnded = true;
    const opened = websocketProvider.receivedOnOpenPayload;
    if (!isReauthCloseReason(data?.event?.reason) || opened === undefined) return;
    void provider.onOpen(opened);
  });
  // A shared-websocketProvider provider does NOT auto-attach (its constructor
  // only auto-attaches when it manages its own socket). Attach explicitly or it
  // never registers / sends its token and hangs in `connecting` forever.
  provider.attach();
  notifyDocProvider(name);
  return provider;
}

/**
 * What is currently true of a document.
 *
 * See {@link DocFacts} for why these belong to the document rather than to
 * whichever component is rendering it, and for which of them can move in both
 * directions. Read on acquire, so a consumer that remounts picks up what it was
 * not there to hear.
 * @param name - Document name previously passed to {@link acquireDocProvider}.
 * @returns A snapshot — always a fresh object, so a caller cannot reach back into the registry through it.
 */
export function readDocFacts(name: string): DocFacts {
  const facts = docEntries.get(name)?.facts ?? { hasEverSynced: false, authFailure: null };
  return { ...facts, sessionEnded };
}

/**
 * Release a document provider. Decrements its reference count; on reaching zero
 * it schedules a DEFERRED teardown (cancellable by a re-acquire, which is how
 * StrictMode re-mounts avoid churn). A real teardown detaches the document from
 * the shared socket — without closing the socket — and closes the socket only
 * once the last document is gone.
 * @param name - Document name previously passed to {@link acquireDocProvider}.
 * @param expectedDoc - When supplied, release only this document's provider generation.
 */
export function releaseDocProvider(name: string, expectedDoc?: Y.Doc): void {
  const entry = docEntries.get(name);
  if (!entry || (expectedDoc !== undefined && entry.doc !== expectedDoc)) return;
  entry.refcount -= 1;
  if (entry.refcount > 0) return;
  entry.pendingRelease = setTimeout(() => {
    if (docEntries.get(name) !== entry) return;
    // detaches from the shared socket (CloseMessage + providerMap removal);
    // does NOT close the shared socket (manageSocket is false).
    // Co-locate the Y.Doc lifecycle with the provider's (#1786): the last
    // consumer is gone, so evict + destroy the cached doc — otherwise the
    // manager cache grows unbounded across a session (destroyDoc had zero
    // production callers). Runs AFTER provider.destroy() so the doc has no
    // attached provider when it is torn down. StrictMode-safe: a re-acquire
    // cancels this deferred callback before it fires, so the doc is never
    // evicted mid-oscillation.
    destroyDocEntry(name, entry);
    maybeDestroySharedSocket();
  }, 0);
}

/**
 * Test-only: synchronously tear down the shared socket + all document providers
 * and clear pending releases. Not for production use.
 */
export function _resetCollabSocketForTests(): void {
  destroyAccountTransport();
  boundAccount = undefined;
}

// ───────────────────────── userId gate (React context) ─────────────────────────

interface CollabSocketContextValue {
  /** Current resolved account; local document scope, never part of the wire name. */
  userId?: string;
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
  /** WebSocket URL or same-origin path; defaults to `VITE_COLLAB_URL` or same-origin `/ws`. */
  url?: string;
  children: React.ReactNode;
}

/**
 * Gates the shared collab socket on `userId` for the whole project subtree.
 * Holds no socket itself — the socket + per-document providers live in the
 * module-level reference-counted registry above. Account changes first retire
 * that registry and socket so a new cookie handshake precedes new documents;
 * the same account keeps the existing deferred reference-counted lifecycle.
 * @param root0 - Provider props.
 * @param root0.userId - Current user id; documents are not attached until this is set.
 * @param root0.url - WebSocket URL or same-origin path; defaults to `VITE_COLLAB_URL` or same-origin `/ws`.
 * @param root0.children - Subtree whose document hooks share the socket.
 * @returns The context provider wrapping the project subtree.
 */
export function CollabSocketProvider({
  userId,
  url = COLLAB_WS_PATH,
  children,
}: CollabSocketProviderProps): React.JSX.Element {
  const [preparedAccount, setPreparedAccount] = React.useState(boundAccount);
  const accountReady = preparedAccount === userId && boundAccount === userId;
  React.useLayoutEffect(() => {
    if (boundAccount !== userId) {
      // A WebSocket upgrade carries one cookie identity for its whole lifetime.
      // Finish the old registry before new children render/get their documents;
      // otherwise a new account could acquire an old meta doc during render.
      destroyAccountTransport();
      boundAccount = userId;
    }
    setPreparedAccount(userId);
    // Ordinary unmount has no account reset: document refcounts own teardown,
    // including StrictMode's cleanup/setup oscillation for the same account.
  }, [userId]);
  const value = React.useMemo<CollabSocketContextValue>(
    () => ({ ready: Boolean(userId) && accountReady, userId, url }),
    [userId, accountReady, url],
  );
  return (
    <CollabSocketContext.Provider value={value}>
      {accountReady ? children : null}
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
