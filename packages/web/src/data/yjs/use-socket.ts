// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { HocuspocusProvider } from '@hocuspocus/provider';
import * as React from 'react';
import type * as Y from 'yjs';
import { reportCollabFailure } from '@web/data/yjs/collab-failure-report';
import {
  acquireDocProvider,
  readDocFacts,
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
 * provider events. Surfaced via `SocketState.status` so UI can
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

/**
 * Whether the SERVER has granted this connection permission to write.
 *
 * Distinct from the role the UI already knows about. A connection comes back
 * read-only for one of four reasons: the user is a viewer; the document
 * already holds as many writers as the owning studio's tier allows; the
 * ceiling could not be resolved at all, which degrades rather than refuses
 * (#88); or the document is the project meta doc, which no client may write
 * regardless of role. The two middle ones are the surprise to the UI — a
 * member it believes may edit cannot. The server answers this on the wire at
 * authentication time; anything it refuses afterwards is discarded silently,
 * with no error and no disconnect, so this is the only warning a client gets.
 *
 *   unknown — not yet authenticated for this document
 *   granted — may write
 *   denied  — authenticated read-only; every update sent will be dropped
 */
export type WriteAccess = 'unknown' | 'granted' | 'denied';

/**
 * Read a provider's already-settled write access.
 *
 * Needed alongside the `authenticated` listener because the provider registry
 * is shared: a document another component acquired first may already have
 * authenticated, and it will not re-emit the event for a late subscriber.
 * @param provider - The document's provider.
 * @returns What the server granted, or `unknown` if it has not answered yet.
 */
function readWriteAccess(provider: HocuspocusProvider): WriteAccess {
  if (!provider.isAuthenticated) return 'unknown';
  return provider.authorizedScope === 'readonly' ? 'denied' : 'granted';
}

interface SocketState {
  /** The active provider (null until first connect). */
  provider: HocuspocusProvider | null;
  /**
   * Whether the provider is in sync RIGHT NOW — not a latch. Cleared on every
   * close (a wifi switch, a laptop waking, a collab redeploy) and set again
   * once the reconnect re-syncs.
   */
  synced: boolean;
  /**
   * Whether this document's content has arrived at least once — the latch
   * {@link synced} is not.
   *
   * Read this to decide whether the document may be shown or edited: once the
   * content is in, the local Y.Doc holds it and offline edits merge cleanly on
   * reconnect, so a dropped socket is no reason to take it off screen.
   *
   * Survives this component being unmounted and remounted, because it is kept
   * with the document in the provider registry rather than here. That is what a
   * Space-tab switch does, and the content is plainly still there across one.
   */
  hasEverSynced: boolean;
  /** High-level connection lifecycle for banner UI. */
  status: ConnectionStatus;
  /**
   * Whether the server granted this connection permission to write. See
   * {@link WriteAccess} — `denied` means updates are being dropped in silence.
   */
  writeAccess: WriteAccess;
  /**
   * Whether the server DEGRADED this connection to read-only, as opposed to
   * refusing the document outright.
   *
   * {@link writeAccess} is `denied` for both, and they need different answers:
   * a degrade clears itself when a seat frees up, so saying so is useful; a
   * refusal means the Space was deleted, membership was revoked or the session
   * expired, and telling that person to wait for a seat is an instruction they
   * cannot carry out. Derived here so both Spaces read one answer instead of
   * each hand-deriving it.
   *
   * The ROLE is deliberately not folded in — this is the connection's state,
   * and a viewer is read-only whatever the connection says. Callers that care
   * add the role themselves.
   */
  degraded: boolean;
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
  // Mirrored into React state so a change re-renders, but OWNED by the
  // registry. This initial value is a plain `false` — the registry is read in
  // the effect below, which is what carries the latch across a remount, since
  // neither a sync nor a refusal is ever announced twice and a component that
  // mounts afterwards can only be told.
  //
  // So the first render after a remount does briefly compute "not yet synced",
  // and a caller that gates its content on this flag renders a placeholder for
  // it. Measured in a browser, sampling every frame across three tab-switch
  // round trips: 235 frames, zero showing the placeholder, and a synchronous
  // read right after the click found none either. Discrete events run the
  // remount, the effect and the follow-up render inside one task, so the
  // browser never gets to paint that first pass.
  const [hasEverSynced, setHasEverSynced] = React.useState(false);
  const [status, setStatus] = React.useState<ConnectionStatus>('connecting');
  const [writeAccess, setWriteAccess] =
    React.useState<WriteAccess>('unknown');
  const [authFailedReason, setAuthFailedReason] = React.useState<
    string | null
  >(null);
  // State, not a ref: this is a value the caller RENDERS from — the caret layer
  // an editor mounts, for one — so its arrival has to re-render subscribers. As
  // a ref it did not, and nothing else in the cold-acquire path did either: all
  // three setState calls below write the value they already hold, so React
  // bails out and the provider lands invisibly. Consumers then saw it only when
  // some unrelated render happened to read the ref — the first `synced` event a
  // network round-trip later, or a keystroke — which reads as "the editor takes
  // a moment to appear" online and never appears at all offline.
  const [provider, setProvider] = React.useState<HocuspocusProvider | null>(
    null,
  );

  React.useEffect(() => {
    // Gated: the shared socket may not be dialed until userId resolves. Acquire
    // nothing and stay `connecting`; the context re-renders `ready` once userId
    // lands, re-running this effect to acquire.
    if (!ready) {
      setStatus('connecting');
      setSynced(false);
      setHasEverSynced(false);
      setWriteAccess('unknown');
      setAuthFailedReason(null);
      setProvider(null);
      return;
    }

    const provider = acquireDocProvider(name, doc, url);
    setProvider(provider);

    // Initialise from the provider's CURRENT state — acquiring an already-synced
    // shared provider won't re-emit `synced`.
    if (provider.synced) {
      setSynced(true);
      setStatus('connected');
    } else {
      setSynced(false);
      setStatus('connecting');
    }
    // Everything already settled comes from the registry, which has been
    // watching this document since it was first acquired — including while this
    // component did not exist. These are the lines that survive a Space-tab
    // switch: neither a sync nor a refusal is ever announced twice, so a
    // component that mounts afterwards can only be told, never hear it.
    const facts = readDocFacts(name);
    setHasEverSynced(facts.hasEverSynced);
    if (facts.authFailure !== null) {
      setStatus('authFailed');
      setAuthFailedReason(facts.authFailure);
      setWriteAccess('denied');
    } else {
      setAuthFailedReason(null);
      // Read from the provider rather than the facts: unlike a refusal, the
      // granted scope can change across reconnects, so the live value wins.
      setWriteAccess(readWriteAccess(provider));
    }

    /**
     * First sync landed → steady-state happy.
     */
    const onSynced = (): void => {
      setSynced(true);
      setHasEverSynced(true);
      setStatus('connected');
    };
    /**
     * Authentication succeeded; the payload carries what we may do with the
     * document. Hocuspocus sends `"readonly"` or `"read-write"`.
     * @param data - Authentication payload carrying the granted scope.
     */
    const onAuthenticated = (data: { scope?: string } | undefined): void => {
      setWriteAccess(data?.scope === 'readonly' ? 'denied' : 'granted');
    };
    /**
     * Server rejected token / membership → surface a sticky auth banner.
     * @param data - Auth-failure payload carrying the server reason.
     */
    const onAuthFailed = (data: { reason?: string } | undefined): void => {
      const reason = data?.reason ?? 'unknown';
      setStatus('authFailed');
      setAuthFailedReason(reason);
      // A refusal is the strongest form of "your updates go nowhere". Leaving
      // this at whatever it was — `granted`, for a document that authenticated
      // fine until the Space was deleted — hands the user a live editor over a
      // dead connection.
      setWriteAccess('denied');
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
    provider.on('authenticated', onAuthenticated);
    provider.on('authenticationFailed', onAuthFailed);
    provider.on('close', onClose);

    return () => {
      // Remove our listeners BEFORE releasing — so the deferred teardown's
      // destroy() close never reaches this hook (no false disconnect report).
      provider.off('synced', onSynced);
      provider.off('authenticated', onAuthenticated);
      provider.off('authenticationFailed', onAuthFailed);
      provider.off('close', onClose);
      setProvider(null);
      releaseDocProvider(name);
      setSynced(false);
      // Not a reset of the latch itself — that lives in the registry and is
      // untouched here. This only clears the local mirror for the case where
      // the effect re-runs for a DIFFERENT document; the branch above then
      // reads the new document's latch.
      setHasEverSynced(false);
      setStatus('connecting');
      setWriteAccess('unknown');
      setAuthFailedReason(null);
    };
  }, [ready, name, doc, url]);

  return {
    provider,
    synced,
    hasEverSynced,
    status,
    writeAccess,
    // A DEGRADE, told apart from a REFUSAL. `writeAccess` is 'denied' for
    // both, so the only thing separating "this document is full" from "the
    // server refused this document outright" is that a refusal also sets
    // `authFailed`. They need different answers — a degrade clears itself
    // when a seat frees up and is worth saying so; a refusal means the Space
    // was deleted, membership was revoked or the session expired, and the
    // seats message would be an instruction the person cannot carry out.
    //
    // Derived HERE, once, because both Spaces need it: hand-deriving it in
    // each is the shape that drifts. What each Space still adds on top is
    // the ROLE — a viewer is read-only by definition and is told nothing.
    degraded: writeAccess === 'denied' && status !== 'authFailed',
    authFailedReason,
  };
}
