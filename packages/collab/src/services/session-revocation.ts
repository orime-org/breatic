// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Closing connections whose session ended (inner#1548).
 *
 * Native upgrade admission and each document's authentication read the session.
 * When the server ends sessions (sign out, sign out of other devices, a password
 * reset) it deletes
 * them and publishes their ids (core `revokeSession` / `revokeAllSessions`);
 * every instance closes the connections opened with them, and the client's
 * re-authentication then fails because the session is gone.
 *
 * Pub/sub delivers only to a confirmed subscription, so three reads cover what
 * it can miss: every confirmed subscription (the first and each one after the
 * subscriber reconnects) re-reads every connection's session, a timer does the
 * same (it is also what catches a session that simply expired), and the
 * `connected` hook reads a new connection's session once more, for a session
 * ended between its document authentication and registration.
 *
 * In a region that does not hold the sessions (inner#1955) a connection
 * carries only its session id: the recheck asks the global region which ids
 * ended (`checkSessions`), and the `connected` check reads this region's
 * revocation tombstones.
 */

import type { Hocuspocus } from "@hocuspocus/server";
import { createLogger, sessionsRevokedChannelName, type Redis } from "@breatic/core";
import { COLLAB_REAUTH_REASONS, type SessionsRevokedEvent } from "@breatic/shared";
import type { AuthContext } from "@collab/hooks/auth.js";
import { listAgentPresence, markAgentsOffline } from "@collab/hooks/presence.js";
import { isMetaDoc } from "@collab/hooks/presence-wiring.js";
import type * as Y from "yjs";

const logger = createLogger("session-revocation");

/** The close a connection gets when its session ended. */
const SESSION_ENDED_CLOSE = { code: 4401, reason: COLLAB_REAUTH_REASONS.sessionEnded };

/** The part of a Hocuspocus connection this module touches. */
interface ClosableConnection {
  context: unknown;
  close: (event: { code: number; reason: string }) => void;
}

/** Reads which user a session token belongs to, or null when it is gone. */
export type ReadSession = (token: string) => Promise<string | null>;

/** Answers which of these session ids have ended. */
export type CheckSessionIds = (sids: readonly string[]) => Promise<string[]>;

/** Whether this region holds a revocation tombstone for a session id. */
export type IsRevoked = (sid: string) => Promise<boolean>;

/** What {@link startSessionRevocation} needs from outside. */
export interface SessionRevocationDeps {
  /** A client on the stream Redis; duplicated for the subscriber. */
  source: Redis;
  /** The session reader (core `getSession` on the session Redis). */
  readSession: ReadSession;
  /** Outside the global region, the global region's `checkSessions`. */
  checkSessionIds?: CheckSessionIds;
  /** How often every connection's session is read again. */
  recheckIntervalMs: number;
  /**
   * Whether an external agent's connection can still be used (core
   * `agentAccessService.isConnectionUsable`); its presence goes offline when
   * not (breatic#1488 §19.2).
   */
  isAgentConnectionUsable?: (connectionId: string) => Promise<boolean>;
}

/** The running service. */
export interface SessionRevocation {
  /** Stop the timer and the subscription. */
  stop: () => Promise<void>;
}

/**
 * Every connection on this instance that carries a session.
 * @param hocuspocus - This instance's Hocuspocus server.
 * @returns The connections with their auth context.
 */
function sessionConnections(hocuspocus: Hocuspocus): Array<{ connection: ClosableConnection; ctx: AuthContext }> {
  const found: Array<{ connection: ClosableConnection; ctx: AuthContext }> = [];
  for (const doc of hocuspocus.documents?.values() ?? []) {
    for (const [connection] of doc.connections) {
      const ctx = connection.context as AuthContext | undefined;
      if (ctx?.session) found.push({ connection, ctx });
    }
  }
  return found;
}

/**
 * Close this instance's connections opened with the announced sessions.
 * @param hocuspocus - This instance's Hocuspocus server.
 * @param raw - The published message.
 */
function closeAnnounced(hocuspocus: Hocuspocus, raw: string): void {
  let event: SessionsRevokedEvent;
  try {
    event = JSON.parse(raw) as SessionsRevokedEvent;
  } catch (err) {
    logger.error({ err, raw }, "session_revocation_message_invalid");
    return;
  }
  if (event?.type !== "sessions:revoked" || !Array.isArray(event.sessionIds)) {
    logger.error({ raw }, "session_revocation_message_invalid");
    return;
  }
  const ended = new Set(event.sessionIds);
  let closed = 0;
  for (const { connection, ctx } of sessionConnections(hocuspocus)) {
    if (ended.has(ctx.session.id)) {
      connection.close(SESSION_ENDED_CLOSE);
      closed += 1;
    }
  }
  if (closed > 0) logger.info({ userId: event.userId, closed }, "session_connections_closed");
  // An agent's credential is announced with its connection id (§19.2).
  let agents = 0;
  for (const meta of loadedMetaDocs(hocuspocus)) {
    agents += markAgentsOffline({ document: meta, matches: (a) => a.userId === event.userId && ended.has(a.connectionId) }).length;
  }
  if (agents > 0) logger.info({ userId: event.userId, agents }, "agent_presence_ended");
}

/**
 * The project meta documents loaded on this instance, where external agents'
 * presence lives.
 * @param hocuspocus - The server.
 * @returns The documents.
 */
function loadedMetaDocs(hocuspocus: Hocuspocus): Y.Doc[] {
  const found: Y.Doc[] = [];
  for (const [name, doc] of hocuspocus.documents ?? []) if (isMetaDoc(name)) found.push(doc);
  return found;
}

/**
 * Check every online external agent in the loaded meta documents against its
 * connection and mark offline the ones whose connection can no longer be
 * used: what an announcement missed while the subscription was down.
 * @param hocuspocus - The server.
 * @param isUsable - Whether a connection can still be used.
 */
async function recheckAgents(hocuspocus: Hocuspocus, isUsable: (connectionId: string) => Promise<boolean>): Promise<void> {
  const metas = loadedMetaDocs(hocuspocus);
  const ids = [...new Set(metas.flatMap((meta) => listAgentPresence(meta).filter((a) => a.online).map((a) => a.connectionId)))];
  if (ids.length === 0) return;
  let ended: Set<string>;
  try {
    ended = new Set((await Promise.all(ids.map(async (id) => [id, await isUsable(id)] as const))).filter(([, ok]) => !ok).map(([id]) => id));
  } catch (err) {
    logger.error({ err, connections: ids.length }, "agent_presence_recheck_failed");
    return;
  }
  for (const meta of metas) markAgentsOffline({ document: meta, matches: (a) => ended.has(a.connectionId) });
}

/**
 * Read every connection's session again and close the ones whose session is
 * gone or now belongs to someone else. When the reads fail nothing is closed;
 * the next round tries again.
 * @param hocuspocus - This instance's Hocuspocus server.
 * @param readSession - The session reader.
 * @param checkSessionIds - Outside the global region, which ids ended.
 * @returns Once every session has been read.
 */
async function recheckAll(
  hocuspocus: Hocuspocus,
  readSession: ReadSession,
  checkSessionIds: CheckSessionIds | undefined,
): Promise<void> {
  const held = sessionConnections(hocuspocus);
  const tokens = [...new Set(held.flatMap(({ ctx }) => (ctx.session.token === null ? [] : [ctx.session.token])))];
  const idsOnly = [...new Set(held.filter(({ ctx }) => ctx.session.token === null).map(({ ctx }) => ctx.session.id))];
  let owners: Map<string, string | null>;
  let endedIds: Set<string>;
  try {
    owners = new Map(await Promise.all(tokens.map(async (token) => [token, await readSession(token)] as const)));
    endedIds = new Set(idsOnly.length > 0 && checkSessionIds ? await checkSessionIds(idsOnly) : []);
  } catch (err) {
    logger.error({ err, sessions: tokens.length + idsOnly.length }, "session_recheck_failed");
    return;
  }
  for (const { connection, ctx } of held) {
    const ended = ctx.session.token === null
      ? endedIds.has(ctx.session.id)
      : owners.get(ctx.session.token) !== ctx.user.id;
    if (ended) connection.close(SESSION_ENDED_CLOSE);
  }
}

/**
 * Close a connection that was just registered if its session has ended since
 * its handshake read it.
 * @param connection - The new connection.
 * @param readSession - The session reader.
 * @param isRevoked - Outside the global region, this region's tombstone check.
 * @returns Once the session has been read.
 * @throws {Error} When the session cannot be read; the `connected` hook logs it.
 */
export async function closeIfSessionEnded(
  connection: ClosableConnection,
  readSession: ReadSession,
  isRevoked?: IsRevoked,
): Promise<void> {
  const ctx = connection.context as AuthContext | undefined;
  if (!ctx?.session) return;
  const { token, id } = ctx.session;
  const ended = token === null
    ? (isRevoked !== undefined && (await isRevoked(id)))
    : (await readSession(token)) !== ctx.user.id;
  if (ended) connection.close(SESSION_ENDED_CLOSE);
}

/**
 * Start closing connections whose session ended. Resolves once the first
 * subscription is confirmed, so the caller can open the port after it.
 * @param hocuspocus - This instance's Hocuspocus server.
 * @param deps - Redis, the session reader and the recheck interval.
 * @returns The running service.
 * @throws {Error} When the first SUBSCRIBE fails.
 */
export async function startSessionRevocation(
  hocuspocus: Hocuspocus,
  deps: SessionRevocationDeps,
): Promise<SessionRevocation> {
  const channel = sessionsRevokedChannelName();
  const subscriber = deps.source.duplicate();
  let stopped = false;

  /**
   * Re-read every session, logging anything unexpected.
   */
  const recheck = (): void => {
    recheckAll(hocuspocus, deps.readSession, deps.checkSessionIds).catch((err: unknown) => {
      logger.error({ err }, "session_recheck_failed");
    });
    if (deps.isAgentConnectionUsable) {
      recheckAgents(hocuspocus, deps.isAgentConnectionUsable).catch((err: unknown) => {
        logger.error({ err }, "agent_presence_recheck_failed");
      });
    }
  };

  subscriber.on("message", (from: string, raw: string) => {
    if (from === channel) closeAnnounced(hocuspocus, raw);
  });
  await subscriber.subscribe(channel);
  logger.info({ channel }, "session_revocation_listening");
  recheck();

  // After a reconnect the subscription is confirmed again before re-reading,
  // so nothing published between the read and the subscription is lost.
  subscriber.on("ready", () => {
    if (stopped) return;
    subscriber.subscribe(channel).then(recheck, (err: unknown) => {
      logger.error({ err }, "session_revocation_resubscribe_failed");
    });
  });

  const timer = setInterval(recheck, deps.recheckIntervalMs);
  timer.unref();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await subscriber.unsubscribe(channel);
      await subscriber.quit();
      logger.info("session_revocation_stopped");
    },
  };
}
