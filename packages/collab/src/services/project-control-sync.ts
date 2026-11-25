// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Cross-process control-plane subscriber.
 *
 * Every collab instance subscribes, and each acts on its own connections:
 *
 *   - `{prefix}:project:{pid}:activity:new` (server, worker) — relay the
 *     activity signal on the `meta` doc.
 *   - `{prefix}:project:{pid}:asset-peaks:ready` (worker) — relay a written
 *     audio waveform on the `meta` doc, with the audio's address.
 *   - `{prefix}:project:{pid}:scene-look:settled` (collab's task listener) —
 *     relay how an uploaded 3D part picture was settled, to its uploader.
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
 * One `psubscribe` on `{prefix}:project:*` covers every one of these channels.
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
import { createLogger, projectControlChannelPattern } from "@breatic/core";
import {
  projectMetaDocName,
  type ActivityNewControlEvent,
  type AssetPeaksReadyControlEvent,
  type SceneLookSettledControlEvent,
  type ProjectConnectionsCloseEvent,
  ACTIVITY_NEW_SIGNAL,
  ASSET_PEAKS_READY_SIGNAL,
  SCENE_LOOK_SETTLED_SIGNAL,
} from "@breatic/shared";
import { closeProjectConnections } from "@collab/services/project-connections.js";
import { relayOnMetaDoc } from "@collab/services/meta-signal.js";

const logger = createLogger("project-control-sync");

type ProjectControlEvent =
  | ActivityNewControlEvent
  | AssetPeaksReadyControlEvent
  | SceneLookSettledControlEvent
  | ProjectConnectionsCloseEvent;

/**
 * Decode one raw control-plane pub/sub message and dispatch it:
 * `project-activity:new` relays the activity signal on the meta doc;
 * `project-connections:close` closes this instance's connections to the
 * project; `project-asset-peaks:ready` relays a written waveform on the meta
 * doc; `project-scene-look:settled` relays how an uploaded 3D part picture was
 * settled as the `scene-look:settled` signal on it. Unknown / unparseable messages are logged and ignored.
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
    relayOnMetaDoc(hocuspocus, projectMetaDocName(event.projectId), { t: ACTIVITY_NEW_SIGNAL, projectId: event.projectId });
    return;
  }

  if (event.type === "project-asset-peaks:ready") {
    // An audio this project references has its waveform; a cut band waiting
    // for it reads the peaks again.
    relayOnMetaDoc(hocuspocus, projectMetaDocName(event.projectId), {
      t: ASSET_PEAKS_READY_SIGNAL,
      projectId: event.projectId,
      assetId: event.assetId,
      url: event.url,
    });
    return;
  }

  if (event.type === "project-scene-look:settled") {
    // Only the uploader's connections get it; their page ends that part's
    // upload and tells them when the picture was not put on.
    const { type: _type, ts: _ts, ...settlement } = event;
    relayOnMetaDoc(
      hocuspocus,
      projectMetaDocName(event.projectId),
      { t: SCENE_LOOK_SETTLED_SIGNAL, ...settlement },
      (context) => context?.user?.id === event.userId,
    );
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

  return async () => {
    if (started) {
      await subscriber.punsubscribe(pattern);
    }
    await subscriber.quit();
    logger.info("project_control_sync_stopped");
  };
}
