// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Where the presence rules meet Hocuspocus.
 *
 * The rules themselves live in `presence.ts` and `awareness-identity.ts` and
 * know nothing about the framework. This module is the only place that reads a
 * hook payload, and it exists so that reading is written once: production wires
 * these four functions into the server, and their tests drive the same four
 * through a real server. A guard whose extraction logic is written twice is a
 * guard that can pass its tests while doing nothing in production, which is
 * exactly what happened to the one this work replaces.
 */

import { parseDocName } from "@breatic/shared";

import { stampConnectionIdentity } from "@collab/hooks/awareness-identity.js";
import {
  markOnline,
  markOffline,
  sweepStalePresence,
} from "@collab/hooks/presence.js";

/** Minimum of a Y.Doc this module needs; avoids importing yjs types here. */
type PresenceDoc = Parameters<typeof markOnline>[0]["document"];

/** What a connection carries once `onAuthenticate` has run. */
interface ConnectionLike {
  context?: { user?: { id?: string } };
  socketId?: string;
}

/** The document as Hocuspocus hands it to a hook. */
interface DocumentLike {
  getConnections?: () => ConnectionLike[];
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
  context?: { user?: { id?: string } };
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

/**
 * Everyone the server is currently holding at least one connection for.
 * @param document - The document to inspect.
 * @returns Their user ids.
 */
function connectedUserIds(document: DocumentLike): Set<string> {
  const ids = new Set<string>();
  for (const connection of document.getConnections?.() ?? []) {
    const id = connection.context?.user?.id;
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * Put the connecting user on the project's list.
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
 * @param deps - Injected clock.
 * @param deps.now - Returns the current time in ms.
 */
export function recordPresenceOnConnect(
  payload: {
    documentName: string;
    instance: { documents: Map<string, unknown> };
    context?: { user?: { id?: string } };
  },
  deps: { now: () => number },
): void {
  if (!isMetaDoc(payload.documentName)) return;
  const userId = userIdOf(payload);
  if (!userId) return;
  const document = payload.instance.documents.get(payload.documentName) as
    | PresenceDoc
    | undefined;
  if (!document) return;
  markOnline({
    documentName: payload.documentName,
    document,
    userId,
    now: deps.now(),
  });
}

/**
 * Take the user off the list — but only once their last connection is gone.
 *
 * A person holds several connections at a time: one socket carries several
 * documents, and they may have several tabs. Marking them absent on the first
 * close would make them vanish from everyone's screen while they are still
 * sitting in another tab.
 * @param payload - The `onDisconnect` hook payload.
 * @param payload.documentName - Document the connection was on.
 * @param payload.document - That document, used to see who is still connected.
 * @param payload.context - Context of the connection that just closed.
 * @param deps - Injected clock.
 * @param deps.now - Returns the current time in ms.
 */
export function recordAbsenceOnDisconnect(
  payload: {
    documentName: string;
    document: PresenceDoc & DocumentLike;
    context?: { user?: { id?: string } };
  },
  deps: { now: () => number },
): void {
  if (!isMetaDoc(payload.documentName)) return;
  const userId = userIdOf(payload);
  if (!userId) return;
  // The closing connection may or may not still be listed depending on where
  // in its teardown this fires, so count what is left rather than assuming.
  if (connectedUserIds(payload.document).has(userId)) return;
  markOffline({ document: payload.document, userId, now: deps.now() });
}

/**
 * Clear records a vanished server left behind, when the document loads.
 *
 * This is the one moment such records can exist and nothing else will correct
 * them: the process that would have written "offline" is gone.
 * @param payload - The `afterLoadDocument` hook payload.
 * @param payload.documentName - Document that just loaded.
 * @param payload.document - That document.
 * @param deps - Injected clock and policy.
 * @param deps.now - Returns the current time in ms.
 * @param deps.staleAfterMs - How long without a heartbeat before an unconnected online record is disbelieved.
 */
export function sweepPresenceOnLoad(
  payload: { documentName: string; document: PresenceDoc & DocumentLike },
  deps: { now: () => number; staleAfterMs: number },
): void {
  if (!isMetaDoc(payload.documentName)) return;
  sweepStalePresence({
    document: payload.document,
    connectedUserIds: connectedUserIds(payload.document),
    now: deps.now(),
    staleAfterMs: deps.staleAfterMs,
  });
}

/**
 * Write the connection's own identity onto the carets it owns.
 *
 * Runs on every document, not just the meta one: carets live in the canvas and
 * document files, and that is where an id turns into a name on somebody's
 * screen.
 * @param payload - The `beforeHandleAwareness` hook payload.
 * @param payload.states - Per-client states decoded from the inbound frame, mutated in place.
 * @param payload.document - The document this frame is for.
 * @param payload.connection - The originating connection, absent for updates relayed between instances.
 * @param payload.context - Connection context, when the hook provides it directly.
 */
export function stampIdentityOnAwareness(payload: {
  states: Map<number, Record<string, unknown>>;
  document: {
    getClients?: (connection: unknown) => Set<number>;
    getConnections?: () => ConnectionLike[];
  };
  connection?: ConnectionLike;
  context?: { user?: { id?: string } };
}): void {
  const userId = userIdOf(payload);
  if (!userId || !payload.connection) return;

  const own = payload.document.getClients?.(payload.connection) ?? new Set();
  const other = new Set<number>();
  for (const connection of payload.document.getConnections?.() ?? []) {
    if (connection === payload.connection) continue;
    for (const clientId of payload.document.getClients?.(connection) ?? []) {
      other.add(clientId);
    }
  }

  stampConnectionIdentity({
    states: payload.states,
    ownClientIds: own,
    otherClientIds: other,
    userId,
  });
}
