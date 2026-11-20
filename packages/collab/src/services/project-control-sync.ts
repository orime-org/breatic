// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cross-process control-plane subscriber.
 *
 * Every collab instance subscribes, and each acts on its own connections:
 *
 *   - `{prefix}:project:{pid}:activity:new` (server, worker) — relay the
 *     activity signal on the `meta` doc.
 *   - `{prefix}:project:{pid}:credits:changed` (server, worker) — relay the
 *     credits signal on the `meta` doc.
 *   - `{prefix}:project:{pid}:space-tasks:changed` (server, worker) — relay
 *     a 3D Space's task list signal on the `meta` doc.
 *   - `{prefix}:project:{pid}:connections:close` (collab's lifecycle
 *     consumer) — close every connection to the project.
 *
 * Signals go out with `relayStateless`, to this instance's connections only:
 * every instance runs this, and `broadcastStateless` would also forward them
 * through the Redis extension, one extra copy per instance.
 *
 * Why pub/sub (not Streams):
 *
 *   - Notification-only event. A consumer that's offline can safely
 *     miss a message; reconnect re-queries PG.
 *   - No replay / consumer-group semantics needed.
 *
 * Space lifecycle (create / delete / lock / restore) used to flow
 * through this same subscriber via `{prefix}:project:{pid}:space:*` channels —
 * removed 2026-05-23 (ADR yjs-collab-only-write-authz). Space writes
 * now happen inside `space-rpc.ts` as collab stateless RPC, so no
 * Redis round-trip is needed.
 *
 * One `psubscribe` on `{prefix}:project:*` covers all three channels.
 *
 * Membership changes do not come through here: `member-change-sync.ts` hears
 * them from the trigger on `project_members`.
 *
 * `{prefix}` is `REDIS_KEY_PREFIX` (defaults to `ENV`), injected in exactly one
 * place — core's `projectControlChannelPattern()`. It is what keeps two
 * deployments on one Redis instance from hearing each other: pub/sub ignores
 * the DB number, so the `REDIS_*_URL` split isolates every ordinary key but not
 * these channels — and what travels here changes what connected clients may do
 * (#1831).
 */

import type { Hocuspocus } from "@hocuspocus/server";
import type { Redis } from "@breatic/core";
import { createLogger, env, getMcpConfig, projectControlChannelPattern } from "@breatic/core";
import {
  notificationsChangedChannel,
  NOTIFICATIONS_CHANGED_SIGNAL,
  parseDocName,
  projectMetaDocName,
  type NotificationsChangedControlEvent,
  type NotificationsChangedSignal,
  type ActivityNewControlEvent,
  type CreditsChangedControlEvent,
  type SpaceTasksChangedControlEvent,
  type AssignmentsChangedControlEvent,
  type ViewCaptureRequestedControlEvent,
  VIEW_CAPTURE_REQUEST_SIGNAL,
  type ViewCaptureRequestSignal,
  type ProjectConnectionsCloseEvent,
  ACTIVITY_NEW_SIGNAL,
  CREDITS_CHANGED_SIGNAL,
  SPACE_TASKS_CHANGED_SIGNAL,
  ASSIGNMENTS_CHANGED_SIGNAL,
  type ActivityNewSignal,
  type CreditsChangedSignal,
  type SpaceTasksChangedSignal,
  type AssignmentsChangedSignal,
} from "@breatic/shared";
import { closeProjectConnections } from "@collab/services/project-connections.js";

const logger = createLogger("project-control-sync");

type ProjectControlEvent =
  | ActivityNewControlEvent
  | CreditsChangedControlEvent
  | SpaceTasksChangedControlEvent
  | AssignmentsChangedControlEvent
  | ViewCaptureRequestedControlEvent
  | ProjectConnectionsCloseEvent;

/**
 * Relay a stateless signal to this instance's connections on a project's meta
 * doc. An instance that holds no connection to the project has no doc loaded
 * and relays nothing.
 * @param hocuspocus - Running Hocuspocus server.
 * @param projectId - The project whose meta doc carries the signal.
 * @param signal - The signal, as its connections parse it.
 */
function relayOnMetaDoc(
  hocuspocus: Hocuspocus,
  projectId: string,
  signal: ActivityNewSignal | CreditsChangedSignal | SpaceTasksChangedSignal | AssignmentsChangedSignal,
): void {
  const docName = projectMetaDocName(projectId);
  const doc = hocuspocus.documents?.get(docName);
  if (!doc) return;
  try {
    doc.relayStateless(JSON.stringify(signal));
  } catch (err) {
    logger.warn({ err, docName, signal: signal.t }, "meta_signal_relay_failed");
  }
}

/**
 * Send a capture request to one member's meta connections on this instance
 * only (breatic#1488 §19.1): their screen is theirs, so no other member's
 * browser hears it.
 * @param hocuspocus - The server.
 * @param event - The request.
 */
export function relayViewCaptureRequest(hocuspocus: Hocuspocus, event: ViewCaptureRequestedControlEvent): void {
  const doc = hocuspocus.documents?.get(projectMetaDocName(event.projectId));
  if (!doc) return;
  const { max_edge_px: maxEdgePx, max_bytes: maxBytes } = getMcpConfig().view_capture;
  const signal: ViewCaptureRequestSignal = {
    t: VIEW_CAPTURE_REQUEST_SIGNAL,
    requestId: event.requestId,
    userId: event.userId,
    maxEdgePx,
    maxBytes,
  };
  for (const [connection] of doc.connections) {
    if ((connection.context as { user?: { id?: string } } | undefined)?.user?.id !== event.userId) continue;
    try {
      connection.sendStateless(JSON.stringify(signal));
    } catch (err) {
      logger.warn({ err, projectId: event.projectId, requestId: event.requestId }, "view_capture_relay_failed");
    }
  }
}

/**
 * Tell each named user's meta connections on this instance that their
 * notifications changed (breatic#1488 §11.9), in whatever project they have
 * open; their project pages read the bell again. A connection that fails is
 * skipped.
 * @param hocuspocus - The server.
 * @param event - Whose notifications changed.
 */
export function relayNotificationsChanged(hocuspocus: Hocuspocus, event: NotificationsChangedControlEvent): void {
  const users = new Set(event.userIds);
  const signal = JSON.stringify({ t: NOTIFICATIONS_CHANGED_SIGNAL } satisfies NotificationsChangedSignal);
  for (const [name, doc] of hocuspocus.documents ?? []) {
    if (parseDocName(name)?.kind !== "meta") continue;
    for (const [connection] of doc.connections) {
      const userId = (connection.context as { user?: { id?: string } } | undefined)?.user?.id;
      if (userId === undefined || !users.has(userId)) continue;
      try {
        connection.sendStateless(signal);
      } catch (err) {
        logger.warn({ err, documentName: name }, "notifications_signal_relay_failed");
      }
    }
  }
}

/**
 * Decode one raw control-plane pub/sub message and dispatch it:
 * `project-activity:new` relays the activity signal on the meta doc;
 * `project-credits:changed` relays the credits signal on the meta doc;
 * `project-space-tasks:changed` relays a Space's task list signal on it;
 * `project-assignments:changed` relays a Space's hand-over signal on it;
 * `project-view-capture:requested` sends a capture request to one member's
 * meta connections;
 * `project-connections:close` closes this instance's connections to the
 * project. Unknown / unparseable messages are logged and ignored.
 * @param hocuspocus - Running Hocuspocus server passed through to the relay and close handlers.
 * @param raw - Raw JSON message body received on the project control channel.
 * @throws {TypeError} When the message decodes to `null`; the subscriber logs it.
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

  if (event.type === "project-activity:new") {
    // Relay a server/worker-written activity row to connected members
    // as the same stateless signal collab-originated rows broadcast
    // directly (ADR 2026-07-04 project-activity-feed).
    relayOnMetaDoc(hocuspocus, event.projectId, { t: ACTIVITY_NEW_SIGNAL, projectId: event.projectId });
    return;
  }

  if (event.type === "project-credits:changed") {
    // A charge made in this project committed; members' top bars read
    // their credits again.
    relayOnMetaDoc(hocuspocus, event.projectId, { t: CREDITS_CHANGED_SIGNAL, projectId: event.projectId });
    return;
  }

  if (event.type === "project-space-tasks:changed") {
    // A 3D Space's task list changed; members with that Space open read it
    // again.
    relayOnMetaDoc(hocuspocus, event.projectId, {
      t: SPACE_TASKS_CHANGED_SIGNAL,
      projectId: event.projectId,
      spaceId: event.spaceId,
    });
    return;
  }

  if (event.type === "project-assignments:changed") {
    // A Space's hand-overs changed; the hand-giver's thread labels read
    // their records again (breatic#1488 §11.7).
    relayOnMetaDoc(hocuspocus, event.projectId, { t: ASSIGNMENTS_CHANGED_SIGNAL, projectId: event.projectId, spaceId: event.spaceId });
    return;
  }

  if (event.type === "project-view-capture:requested") {
    relayViewCaptureRequest(hocuspocus, event);
    return;
  }

  if (event.type === "project-connections:close") {
    if (!closeProjectConnections(hocuspocus, event.projectId, event.reason)) {
      logger.warn({ projectId: event.projectId, reason: event.reason }, "unknown_connections_close_reason");
      return;
    }
    logger.info({ projectId: event.projectId, reason: event.reason }, "project_connections_closed");
    return;
  }

  logger.warn(
    { type: (event as { type?: string }).type },
    "unknown_control_event_type",
  );
}

/**
 * Start the project control-plane subscriber on the given Redis client.
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
export function startProjectControlSync(
  hocuspocus: Hocuspocus,
  redis: Redis,
): () => Promise<void> {
  const subscriber = redis.duplicate();
  let started = false;
  // Resolved once: subscribe, log and unsubscribe must all name the SAME
  // pattern. Re-deriving it per call site is how a subscriber ends up deaf to
  // its own publishers without any error surfacing.
  const pattern = projectControlChannelPattern();
  const notifications = notificationsChangedChannel(env.REDIS_KEY_PREFIX);

  subscriber.psubscribe(pattern, (err) => {
    if (err) {
      logger.error({ err }, "project_control_sync_subscribe_failed");
      return;
    }
    started = true;
    logger.info(
      { pattern },
      "project_control_sync_started",
    );
  });

  subscriber.on("pmessage", (_pattern, channel, message) => {
    handleEvent(hocuspocus, message).catch((err: unknown) => {
      logger.error({ err, channel }, "control_event_failed");
    });
  });

  // One deployment-wide channel: a member's project pages may be on any
  // instance, in any project (breatic#1488 §11.9).
  subscriber.subscribe(notifications, (err) => {
    if (err) logger.error({ err }, "notifications_changed_subscribe_failed");
  });
  subscriber.on("message", (channel, message) => {
    if (channel !== notifications) return;
    try {
      relayNotificationsChanged(hocuspocus, JSON.parse(message) as NotificationsChangedControlEvent);
    } catch (err) {
      logger.error({ err, channel }, "notifications_changed_relay_failed");
    }
  });

  return async () => {
    if (started) {
      await subscriber.punsubscribe(pattern);
    }
    await subscriber.unsubscribe(notifications);
    await subscriber.quit();
    logger.info("project_control_sync_stopped");
  };
}
