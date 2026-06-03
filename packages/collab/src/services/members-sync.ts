// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Cross-process control-plane subscriber (members channel only).
 *
 * The API server publishes pub/sub events on Redis DB2:
 *
 *   - `project:{pid}:members:changed` — kick the affected user's
 *     ws connections to this project's docs (close 4403 forces an
 *     onAuthenticate re-check), then broadcastStateless an
 *     invalidate signal to the project's `meta` doc so other
 *     connected clients re-fetch their members cache.
 *
 * Why pub/sub (not Streams):
 *
 *   - Notification-only event. A consumer that's offline can safely
 *     miss a message; reconnect re-queries PG.
 *   - No replay / consumer-group semantics needed.
 *
 * Space lifecycle (create / delete / lock / restore) used to flow
 * through this same subscriber via `project:{pid}:space:*` channels —
 * removed 2026-05-23 (ADR yjs-collab-only-write-authz). Space writes
 * now happen inside `space-rpc.ts` as collab stateless RPC, so no
 * Redis round-trip is needed.
 *
 * One `psubscribe('project:*')` covers the remaining channel — kept
 * as a pattern subscription in case future control-plane events join.
 */

import type { Hocuspocus } from "@hocuspocus/server";
import type { Redis } from "@breatic/core";
import {
  ALL_PROJECT_CHANNELS_PATTERN,
  parseDocName,
  projectMetaDocName,
  type MembersChangedEvent,
} from "@breatic/shared";
import { createLogger } from "@collab/infra/logger.js";

const logger = createLogger("members-sync");

type ProjectControlEvent = MembersChangedEvent;

/**
 * Best-effort kick — close every ws connection the user holds to
 * any doc under this project. The Hocuspocus client reconnects
 * automatically; the next `onAuthenticate` re-runs the role lookup
 * with the freshly-written `project_members` state.
 * @param hocuspocus - Running Hocuspocus server whose loaded documents are scanned for the user's connections.
 * @param projectId - Project whose docs the kick is restricted to.
 * @param userId - User whose connections are closed with code 4403 to force an onAuthenticate re-check.
 */
function kickUserFromProject(
  hocuspocus: Hocuspocus,
  projectId: string,
  userId: string,
): void {
  // Hocuspocus exposes connections via the per-document map; we walk
  // all loaded docs and close connections whose user.id matches.
  // The doc-name filter restricts the kick to this project.
  const docs = hocuspocus.documents;
  if (!docs) return;
  for (const [docName, doc] of docs.entries()) {
    const parsed = parseDocName(docName);
    if (!parsed || parsed.projectId !== projectId) continue;
    for (const [, connection] of doc.connections) {
      const ctxUser = (connection.connection.context as { user?: { id?: string } } | undefined)?.user;
      if (ctxUser?.id === userId) {
        connection.connection.close({ code: 4403, reason: "Permission changed, please reconnect" });
      }
    }
  }
}

/**
 * Broadcast a stateless invalidate signal on the project's meta
 * doc. Frontend clients subscribed via
 * `metaProvider.on('stateless', handler)` re-fetch their members
 * cache (and any other invalidated state).
 *
 * If no client is connected (Document not loaded), this is a no-op
 * — connected clients will rehydrate via REST on next page load.
 * @param hocuspocus - Running Hocuspocus server holding the project's loaded meta doc.
 * @param projectId - Project whose meta doc receives the stateless broadcast.
 * @param payload - Control event serialized and sent as the stateless invalidate signal.
 */
function broadcastInvalidate(
  hocuspocus: Hocuspocus,
  projectId: string,
  payload: ProjectControlEvent,
): void {
  const docName = projectMetaDocName(projectId);
  const doc = hocuspocus.documents?.get(docName);
  if (!doc) return;
  try {
    doc.broadcastStateless(JSON.stringify(payload));
  } catch (err) {
    logger.warn({ err, docName }, "broadcast_stateless_failed");
  }
}

/**
 * Decode one raw control-plane pub/sub message and dispatch it. For a
 * `project-members:changed` event, kick the affected user(s) and
 * broadcast a meta-doc invalidate; unknown / unparseable messages are
 * logged and ignored.
 * @param hocuspocus - Running Hocuspocus server passed through to the kick / broadcast handlers.
 * @param raw - Raw JSON message body received on the project control channel.
 */
async function handleEvent(
  hocuspocus: Hocuspocus,
  raw: string,
): Promise<void> {
  let event: ProjectControlEvent;
  try {
    event = JSON.parse(raw) as ProjectControlEvent;
  } catch (err) {
    logger.warn({ err, raw }, "control_event_parse_failed");
    return;
  }

  if (event.type === "project-members:changed") {
    if (event.affectedUserId !== "all") {
      kickUserFromProject(hocuspocus, event.projectId, event.affectedUserId);
    } else {
      // owner-transfer: kick both sides
      if (event.fromUserId) {
        kickUserFromProject(hocuspocus, event.projectId, event.fromUserId);
      }
      if (event.toUserId) {
        kickUserFromProject(hocuspocus, event.projectId, event.toUserId);
      }
    }
    broadcastInvalidate(hocuspocus, event.projectId, event);
    logger.info(
      {
        projectId: event.projectId,
        action: event.action,
        affectedUserId: event.affectedUserId,
      },
      "members_changed_handled",
    );
    return;
  }

  logger.warn(
    { type: (event as { type?: string }).type },
    "unknown_control_event_type",
  );
}

/**
 * Start the members-sync subscriber on the given Redis client.
 *
 * Returns a cleanup function that unsubscribes and quits the
 * subscriber connection. The caller still owns the original
 * `redis` argument; we duplicate it here because pub/sub
 * subscribers must be on a dedicated connection.
 * @param hocuspocus - Running Hocuspocus server instance
 * @param redis - Source Redis client (DB2 / `REDIS_STREAM_URL`);
 *   we `.duplicate()` it for the dedicated subscriber connection
 * @returns async cleanup function
 */
export function startMembersSync(
  hocuspocus: Hocuspocus,
  redis: Redis,
): () => Promise<void> {
  const subscriber = redis.duplicate();
  let started = false;

  subscriber.psubscribe(ALL_PROJECT_CHANNELS_PATTERN, (err) => {
    if (err) {
      logger.error({ err }, "members_sync_subscribe_failed");
      return;
    }
    started = true;
    logger.info(
      { pattern: ALL_PROJECT_CHANNELS_PATTERN },
      "members_sync_started",
    );
  });

  subscriber.on("pmessage", (_pattern, _channel, message) => {
    void handleEvent(hocuspocus, message);
  });

  return async () => {
    if (started) {
      await subscriber.punsubscribe(ALL_PROJECT_CHANNELS_PATTERN);
    }
    await subscriber.quit();
    logger.info("members_sync_stopped");
  };
}
