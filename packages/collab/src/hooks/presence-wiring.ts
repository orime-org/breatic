// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where the presence rules meet Hocuspocus.
 *
 * The rules themselves live in `presence.ts` and `awareness-identity.ts` and
 * know nothing about the framework. This module is the only place that reads a
 * hook payload, and it exists so that reading is written once: production wires
 * these functions into the server, and their tests drive the same ones through a
 * real server. A guard whose extraction logic is written twice is a guard that
 * can pass its tests while doing nothing in production, which is exactly what
 * happened to the one this work replaces.
 *
 * ## Presence rides the transport, not the page
 *
 * A record moves forward on one thing: the socket answering its ping. The
 * refresh that does it is the only one exported, so nothing can quietly wire
 * the roster back onto something the browser is free to throttle.
 *
 * ## There is deliberately no disconnect function here
 *
 * A socket closing is not evidence that its owner left: they may hold another
 * one, on this machine or another, and this machine can only see its own. So
 * nothing writes "offline" on a disconnect. Absence is inferred by the sweep,
 * from nobody anywhere refreshing the timestamp — see `presence.ts`. The
 * absence of a function here IS the enforcement; a test cannot easily prove a
 * hook was left unwired, but code that does not exist cannot be called.
 */

import { parseDocName } from "@breatic/shared";

import { stampConnectionIdentity } from "@collab/hooks/awareness-identity.js";
import {
  markOnline,
  touchLastSeen,
  sweepStalePresence,
} from "@collab/hooks/presence.js";

/** Minimum of a Y.Doc this module needs; avoids importing yjs types here. */
type PresenceDoc = Parameters<typeof markOnline>[0]["document"];

/**
 * The context Hocuspocus attaches to a connection once `onAuthenticate` has run,
 * as much of it as presence reads.
 *
 * Named rather than written inline at each hook payload, so that the doc rule
 * stops descending here. Spelled out at every call site it would demand a
 * `@param` line per level — eight of them across this file, all saying the
 * same thing.
 *
 * Not the auth hook's own `AuthContext`, which also carries `handedOverFrom`
 * and is what that hook RESOLVES. This is what a later hook finds attached.
 */
interface PresenceContext {
  user?: { id?: string };
}

/** What a connection carries once `onAuthenticate` has run. */
interface ConnectionLike {
  context?: PresenceContext;
  socketId?: string;
}

/** The running server, as much of it as this module reaches for. */
interface InstanceLike {
  documents: Map<string, unknown>;
}

/**
 * Read the authenticated user id off whatever the payload carries it in.
 *
 * `connected` and `onDisconnect` hand over a bare `context`; the awareness hook
 * hands over the `connection` and leaves `context` undefined when the update
 * was relayed from another instance rather than sent by a client.
 * @param payload - The hook payload.
 * @param payload.context - Connection context, when the hook provides one directly.
 * @param payload.connection - The originating connection, when the hook provides that instead.
 * @returns The user id, or undefined when there is no client behind this call.
 */
function userIdOf(payload: {
  context?: PresenceContext;
  connection?: ConnectionLike;
}): string | undefined {
  return payload.context?.user?.id ?? payload.connection?.context?.user?.id;
}

/**
 * Whether this is a project's meta document, the one presence lives in.
 * @param documentName - Name of the document a hook fired for.
 * @returns True for a meta document.
 */
function isMetaDoc(documentName: string): boolean {
  const parsed = parseDocName(documentName);
  return parsed !== null && parsed.kind === "meta";
}

/** How presence decides things, injected so tests can move the clock. */
export interface PresencePolicy {
  /** Returns the current time in ms. */
  now: () => number;
  /** How long without a pong before an online record is disbelieved. */
  staleAfterMs: number;
}

/**
 * Put the connecting user on the project's list, and clear whoever nobody is
 * refreshing any more.
 *
 * Wired to `connected`, which fires after `onAuthenticate` — so the id here is
 * the one the server resolved from the credential, never one a client offered.
 *
 * Unlike the other hooks, this payload does not carry the document (measured
 * against `connectedPayload` in 4.5.0: documentName, context, instance,
 * connection, socketId, and the request, but no `document`). It is fetched from
 * the instance instead. A connection cannot reach this hook before its document
 * is loaded, so the lookup is expected to succeed; returning quietly if it does
 * not is better than throwing inside a lifecycle hook.
 * @param payload - The `connected` hook payload.
 * @param payload.documentName - Document the connection opened.
 * @param payload.instance - The server, used to look the document up.
 * @param payload.context - Connection context established by `onAuthenticate`.
 * @param policy - Clock and presence thresholds.
 */
export function recordPresenceOnConnect(
  payload: {
    documentName: string;
    instance: InstanceLike;
    context?: PresenceContext;
  },
  policy: PresencePolicy,
): void {
  if (!isMetaDoc(payload.documentName)) return;
  const userId = userIdOf(payload);
  if (!userId) return;
  const document = payload.instance.documents.get(payload.documentName) as
    | PresenceDoc
    | undefined;
  if (!document) return;
  const now = policy.now();
  markOnline({ document, userId, now });
  // Someone arriving is the earliest chance to clean up after a server that
  // went away, and it costs one pass over a small map.
  sweepStalePresence({ document, now, staleAfterMs: policy.staleAfterMs });
}

/**
 * One of a socket's connections, as much of it as presence reads.
 *
 * A slice of the same Hocuspocus `Connection` that `HeldConnection`
 * (`services/live-connections.ts`) and `DemotableConnection`
 * (`services/seat-handover.ts`) describe, each naming what its own reader
 * touches. The compiler holds this one to `HeldConnection`: the per-socket
 * table hands its map straight to the pong handler built from this.
 */
export interface SocketConnection {
  /** Connection context established by `onAuthenticate`. */
  context?: PresenceContext;
  /** The document this connection is for. */
  document: PresenceDoc;
}

/**
 * A socket answered its ping, so whoever owns it is still here: push their
 * timestamp forward, and sweep.
 *
 * This is the only way a presence record moves forward, and it is deliberately
 * the only refresh this module exports: a browser's JS timers are throttled to
 * once a minute in a tab hidden for more than five minutes, so a roster driven
 * by anything the page has to run would flip a connected person offline once
 * the threshold cleared. The transport's pong is answered by the network stack
 * under RFC 6455 and needs no JavaScript at all.
 *
 * It hangs off the socket's META connection rather than the seat index. Seats
 * exclude meta documents and read-only connections by definition, so a
 * viewer's socket holds no seat anywhere and asking the index who owns it
 * would never answer. A socket has exactly one meta connection, so this writes
 * once per pong however many Spaces the member has open — which is why the
 * loop returns at the first one rather than carrying on.
 *
 * Sweeping here rather than on a timer is what lets a crashed process be
 * cleaned up at all. The predecessor ran once when the document loaded, which
 * is the moment the records are FRESHEST — a client reconnecting seconds after
 * a restart made every ghost look alive — and the document then stayed loaded
 * for as long as anyone was in it, so the pass never came round again. Riding
 * the refresh turns the threshold into a delay instead of a single missed
 * chance, and costs one walk of a per-project map per refresh per person.
 * @param connections - Everything this socket carries, by document name.
 * @param policy - Clock and presence threshold.
 */
export function refreshPresenceForSocket(
  connections: ReadonlyMap<string, SocketConnection>,
  policy: PresencePolicy,
): void {
  for (const [documentName, connection] of connections) {
    if (!isMetaDoc(documentName)) continue;
    const userId = userIdOf({ context: connection.context });
    if (!userId) return;
    const now = policy.now();
    if (!touchLastSeen({ document: connection.document, userId, now })) return;
    sweepStalePresence({
      document: connection.document,
      now,
      staleAfterMs: policy.staleAfterMs,
    });
    return;
  }
}

/**
 * Write the connection's own identity onto every caret in one frame.
 *
 * Runs on every document, not just the meta one: carets live in the canvas and
 * document files, and that is where an id turns into a name on somebody's
 * screen.
 *
 * The document is not read. It used to be, to ask which client ids belonged to
 * which connection, and that question is gone — see `awareness-identity.ts`.
 * @param payload - The `beforeHandleAwareness` hook payload.
 * @param payload.states - Per-client states decoded from the inbound frame, mutated in place.
 * @param payload.connection - The originating connection, absent for updates relayed between instances.
 * @param payload.context - Connection context, when the hook provides it directly.
 */
export function stampIdentityOnAwareness(payload: {
  states: Map<number, Record<string, unknown>>;
  connection?: ConnectionLike;
  context?: PresenceContext;
}): void {
  const userId = userIdOf(payload);
  if (!userId || !payload.connection) return;

  stampConnectionIdentity({ states: payload.states, userId });
}
