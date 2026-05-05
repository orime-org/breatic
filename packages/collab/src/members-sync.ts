/**
 * Cross-process control-plane subscriber (v10).
 *
 * The API server publishes pub/sub events on Redis DB2:
 *
 *   - `project:{pid}:members:changed` — kick the affected user's
 *     ws connections to this project's docs (close 4403 forces an
 *     onAuthenticate re-check), then broadcastStateless an
 *     invalidate signal to the project's `meta` doc so other
 *     connected clients re-fetch their members cache.
 *   - `project:{pid}:space:created` — apply
 *     `meta.spaces[spaceId] = {...}` so connected frontends see the
 *     new tab via Yjs sync.
 *   - `project:{pid}:space:deleted` — apply
 *     `meta.spaces.delete(spaceId)`. The API has already
 *     soft-deleted the corresponding `yjs_documents` row directly.
 *
 * Why pub/sub (not Streams):
 *
 *   - These are notification-only events. A consumer that's
 *     offline can safely miss a message; reconnect re-queries PG /
 *     reads Yjs.
 *   - No replay / consumer-group semantics needed.
 *
 * One `psubscribe('project:*')` covers all topics — we discriminate
 * by event payload `type` field. Channel name parsing is avoided to
 * keep the listener simple.
 */

import type { Hocuspocus } from "@hocuspocus/server";
import type Redis from "ioredis";
import * as Y from "yjs";
import {
  ALL_PROJECT_CHANNELS_PATTERN,
  parseDocName,
  projectMetaDocName,
  type MembersChangedEvent,
  type SpaceCreatedEvent,
  type SpaceDeletedEvent,
} from "@breatic/shared";
import { createLogger } from "./logger.js";

const logger = createLogger("members-sync");

type ProjectControlEvent =
  | MembersChangedEvent
  | SpaceCreatedEvent
  | SpaceDeletedEvent;

/**
 * Best-effort kick — close every ws connection the user holds to
 * any doc under this project. The Hocuspocus client reconnects
 * automatically; the next `onAuthenticate` re-runs the role lookup
 * with the freshly-written `project_members` state.
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
 * Apply `meta.spaces[spaceId] = {...}` on the project's meta doc.
 *
 * Idempotent — if the entry already exists (replay or duplicate
 * publish), the second `set` is a no-op (Y.Map last-write-wins).
 */
async function applySpaceCreated(
  hocuspocus: Hocuspocus,
  ev: SpaceCreatedEvent,
): Promise<void> {
  const docName = projectMetaDocName(ev.projectId);
  const conn = await hocuspocus.openDirectConnection(docName, {
    context: { user: { id: "system" }, source: "members-sync" },
  });
  try {
    await conn.transact((doc: Y.Doc) => {
      // Origin tag is set inside the inner Y.Doc.transact below;
      // DirectConnection.transact itself does not take an origin arg.
      const spaces = doc.getMap("spaces");
      const existing = spaces.get(ev.spaceId);
      if (existing instanceof Y.Map) {
        // Idempotent reapply — leave the existing entry untouched.
        return;
      }
      const entry = new Y.Map();
      entry.set("id", ev.spaceId);
      entry.set("type", ev.spaceType);
      entry.set("name", ev.name);
      entry.set("order", spaces.size);
      entry.set("locked", false);
      entry.set("createdAt", ev.ts);
      entry.set("createdBy", ev.createdBy);
      spaces.set(ev.spaceId, entry);
    });
  } finally {
    await conn.disconnect();
  }
}

/** Remove `meta.spaces[spaceId]` from the project's meta doc. */
async function applySpaceDeleted(
  hocuspocus: Hocuspocus,
  ev: SpaceDeletedEvent,
): Promise<void> {
  const docName = projectMetaDocName(ev.projectId);
  const conn = await hocuspocus.openDirectConnection(docName, {
    context: { user: { id: "system" }, source: "members-sync" },
  });
  try {
    await conn.transact((doc: Y.Doc) => {
      // Origin tag is set inside the inner Y.Doc.transact below;
      // DirectConnection.transact itself does not take an origin arg.
      const spaces = doc.getMap("spaces");
      if (spaces.has(ev.spaceId)) {
        spaces.delete(ev.spaceId);
      }
    });
  } finally {
    await conn.disconnect();
  }
}

/**
 * Broadcast a stateless invalidate signal on the project's meta
 * doc. Frontend clients subscribed via
 * `metaProvider.on('stateless', handler)` re-fetch their members
 * cache (and any other invalidated state).
 *
 * `broadcastStateless` lives on the per-Document instance, not on
 * the Hocuspocus server itself — we look up the Document via
 * `hocuspocus.documents.get(docName)` and broadcast directly. If
 * no client is connected (Document not loaded), this is a no-op
 * — connected clients will rehydrate via REST on next page load.
 */
function broadcastInvalidate(
  hocuspocus: Hocuspocus,
  projectId: string,
  payload: ProjectControlEvent,
): void {
  const docName = projectMetaDocName(projectId);
  const doc = hocuspocus.documents?.get(docName);
  if (!doc) return; // No client connected to this project's meta — nothing to invalidate.
  try {
    doc.broadcastStateless(JSON.stringify(payload));
  } catch (err) {
    logger.warn({ err, docName }, "broadcast_stateless_failed");
  }
}

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

  if (event.type === "project-space:created") {
    try {
      await applySpaceCreated(hocuspocus, event);
      // Stateless broadcast is optional for spaces (the meta-doc
      // mutation already propagates via Yjs sync), but we do it for
      // parity so any future client-side logic that listens to the
      // generic `project-{pid}/meta` stateless channel sees a single
      // event shape across all control-plane changes.
      broadcastInvalidate(hocuspocus, event.projectId, event);
      logger.info(
        { projectId: event.projectId, spaceId: event.spaceId },
        "space_created_handled",
      );
    } catch (err) {
      logger.error({ err, event }, "space_created_apply_failed");
    }
    return;
  }

  if (event.type === "project-space:deleted") {
    try {
      await applySpaceDeleted(hocuspocus, event);
      broadcastInvalidate(hocuspocus, event.projectId, event);
      logger.info(
        { projectId: event.projectId, spaceId: event.spaceId },
        "space_deleted_handled",
      );
    } catch (err) {
      logger.error({ err, event }, "space_deleted_apply_failed");
    }
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
 *
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
