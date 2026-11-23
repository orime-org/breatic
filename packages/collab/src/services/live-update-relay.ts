// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Telling this instance's connections what changed behind a Project page (#1580).
 *
 * Two sources reach every collab instance: the `live_updates` triggers (core `listenLiveUpdates`) and the uploads
 * ended at the finish (`uploadEndedChannelName`, Redis pub/sub). Each instance tells only its own connections, with
 * `relayStateless`, on meta documents:
 *
 *   - a bell change or an upload's ending goes to the person's meta connections on any Project, with no `projectId`;
 *   - a transfer change goes to the Project's meta document;
 *   - a credits change goes to the meta document of every live Project of the Studio this instance has loaded.
 *
 * Messages carry the kind and the ids only, except an upload's ending, which carries the uploader's own status. A
 * change committed while an instance is not listening is not delivered; a page reads the state again when it opens.
 */

import type { Hocuspocus } from "@hocuspocus/server";
import {
  createLogger,
  uploadEndedChannelName,
  type LiveUpdate,
  type LiveUpdatesHandlers,
  type LiveUpdatesListener,
  type Redis,
} from "@breatic/core";
import {
  CREDITS_CHANGED_SIGNAL,
  NOTIFICATIONS_CHANGED_SIGNAL,
  parseDocName,
  projectMetaDocName,
  PROJECT_TRANSFER_CHANGED_SIGNAL,
  UPLOAD_ENDED_SIGNAL,
  type UploadEndedEvent,
} from "@breatic/shared";
import { relayOnMetaDoc, type MetaSignal } from "@collab/services/meta-signal.js";

const logger = createLogger("live-update-relay");

/** What {@link startLiveUpdateRelay} needs from outside. */
export interface LiveUpdateRelayDeps {
  /** Starts the trigger listener (core `listenLiveUpdates`). */
  listen: (handlers: LiveUpdatesHandlers) => Promise<LiveUpdatesListener>;
  /** The live Projects of a Studio (core `projectsRepo.listLiveProjectIdsInStudio`). */
  listLiveProjectIdsInStudio: (studioId: string) => Promise<string[]>;
  /** Redis client (DB2) duplicated for the upload-ending subscription. */
  source: Redis;
}

/** A running relay. */
export interface LiveUpdateRelay {
  /** Stop listening and close the subscription. */
  stop: () => Promise<void>;
}

/**
 * Send a person's signal to their connections on every loaded meta document.
 * @param hocuspocus - This instance's Hocuspocus server.
 * @param userId - The person.
 * @param signal - The signal.
 */
function relayToPerson(hocuspocus: Hocuspocus, userId: string, signal: MetaSignal): void {
  for (const docName of hocuspocus.documents?.keys() ?? []) {
    if (parseDocName(docName)?.kind !== "meta") continue;
    relayOnMetaDoc(hocuspocus, docName, signal, (context) => context?.user?.id === userId);
  }
}

/**
 * Tell this instance's connections about one trigger update.
 * @param hocuspocus - This instance's Hocuspocus server.
 * @param deps - Where a Studio's Projects are read.
 * @param update - The update.
 * @returns Once every loaded document concerned was told.
 */
async function relayUpdate(hocuspocus: Hocuspocus, deps: LiveUpdateRelayDeps, update: LiveUpdate): Promise<void> {
  if (update.k === "notifications") {
    relayToPerson(hocuspocus, update.u, { t: NOTIFICATIONS_CHANGED_SIGNAL });
    return;
  }
  if (update.k === "project-transfer") {
    relayOnMetaDoc(hocuspocus, projectMetaDocName(update.p), { t: PROJECT_TRANSFER_CHANGED_SIGNAL, projectId: update.p });
    return;
  }
  for (const projectId of await deps.listLiveProjectIdsInStudio(update.s)) {
    relayOnMetaDoc(hocuspocus, projectMetaDocName(projectId), { t: CREDITS_CHANGED_SIGNAL, projectId });
  }
}

/**
 * Tell the uploader's connections that an upload ended.
 * @param hocuspocus - This instance's Hocuspocus server.
 * @param raw - The published message.
 */
function relayUploadEnded(hocuspocus: Hocuspocus, raw: string): void {
  let event: UploadEndedEvent;
  try {
    event = JSON.parse(raw) as UploadEndedEvent;
  } catch (err) {
    logger.error({ err, raw }, "upload_ended_parse_failed");
    return;
  }
  if (event.type !== "upload:ended" || typeof event.userId !== "string" || typeof event.status?.key !== "string") {
    logger.error({ raw }, "upload_ended_payload_invalid");
    return;
  }
  relayToPerson(hocuspocus, event.userId, { t: UPLOAD_ENDED_SIGNAL, key: event.status.key, status: event.status });
}

/**
 * Start telling this instance's connections what changed behind their pages.
 * @param hocuspocus - This instance's Hocuspocus server.
 * @param deps - The listener, the Studio's Projects and the Redis source.
 * @returns The running relay; stop it on shutdown.
 * @throws {Error} When the first LISTEN or the first SUBSCRIBE fails.
 */
export async function startLiveUpdateRelay(hocuspocus: Hocuspocus, deps: LiveUpdateRelayDeps): Promise<LiveUpdateRelay> {
  const listener = await deps.listen({
    onUpdate: (update) => {
      relayUpdate(hocuspocus, deps, update).catch((err: unknown) => {
        logger.error({ err, update }, "live_update_relay_failed");
      });
    },
    onListening: () => {
      logger.info("live_updates_listening");
    },
    onInvalid: (raw) => {
      logger.error({ raw }, "live_update_payload_invalid");
    },
  });

  const channel = uploadEndedChannelName();
  // ioredis subscribes again by itself after a reconnect (autoResubscribe).
  const subscriber = deps.source.duplicate();
  subscriber.on("message", (from: string, raw: string) => {
    if (from === channel) relayUploadEnded(hocuspocus, raw);
  });
  await subscriber.subscribe(channel);

  return {
    stop: async () => {
      await listener.stop();
      await subscriber.unsubscribe(channel);
      await subscriber.quit();
    },
  };
}
