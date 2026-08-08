// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
 * The context Hocuspocus attaches to a connection once `onAuthenticate` has run.
 *
 * Named rather than written inline at each hook payload, so that the doc rule
 * stops descending here. Spelled out at every call site it would demand a
 * `@param` line per level — eight of them across this file, all saying the
 * same thing.
 */
interface AuthContext {
  user?: { id?: string };
}

/** What a connection carries once `onAuthenticate` has run. */
interface ConnectionLike {
  context?: AuthContext;
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
  context?: AuthContext;
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
interface PresencePolicy {
  /** Returns the current time in ms. */
  now: () => number;
  /** How long without a heartbeat before an online record is disbelieved. */
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
    context?: AuthContext;
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
 * Take one heartbeat: push this user's timestamp forward, and sweep.
 *
 * Sweeping here rather than on a timer is what lets a crashed process be
 * cleaned up at all. The predecessor ran once when the document loaded, which
 * is the moment the records are FRESHEST — a client reconnecting seconds after
 * a restart made every ghost look alive — and the document then stayed loaded
 * for as long as anyone was in it, so the pass never came round again. Riding
 * the heartbeat turns the threshold into a delay instead of a single missed
 * chance, and costs one walk of a per-project map per heartbeat per person.
 * @param payload - The `onAwarenessUpdate` hook payload.
 * @param payload.documentName - Document the frame was for.
 * @param payload.document - That document.
 * @param payload.connection - The connection the frame came from.
 * @param policy - Clock and presence threshold.
 */
export function recordHeartbeat(
  payload: {
    documentName: string;
    document: PresenceDoc;
    connection?: ConnectionLike;
  },
  policy: PresencePolicy,
): void {
  if (!isMetaDoc(payload.documentName)) return;
  const userId = userIdOf(payload);
  if (!userId) return;
  const now = policy.now();
  const wrote = touchLastSeen({ document: payload.document, userId, now });
  if (!wrote) return;
  sweepStalePresence({
    document: payload.document,
    now,
    staleAfterMs: policy.staleAfterMs,
  });
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
  context?: AuthContext;
}): void {
  const userId = userIdOf(payload);
  if (!userId || !payload.connection) return;

  stampConnectionIdentity({ states: payload.states, userId });
}
