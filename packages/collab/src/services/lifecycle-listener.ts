// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Project-lifecycle commands, from the cross-service stream (inner#1497 §6.2).
 *
 * The server's transactional-outbox relay forwards each command onto
 * `${env}:stream:project-lifecycle`. Every collab instance reads it as one
 * consumer group, so each command is held by one instance at a time (an
 * unacknowledged one goes to another once idle). That instance does the part that
 * must happen once and then asks every instance to close its own
 * connections to the project:
 *
 *   - `project:duplicated` → copy the source's meta doc and the content rows
 *                            of the Spaces it lists to `project-{new}/` in the
 *                            yjs DB, then close the new project's connections
 *                            so a client that raced in and lazy-seeded a
 *                            default meta reloads the copied content.
 *   - `project:archived`   → close the project's connections, so members
 *                            re-authenticate and come back read-only.
 *   - `project:restored`   → close the project's connections, so members
 *                            re-authenticate and come back writable.
 *
 * A command is acknowledged once the close request is published; a copy or a
 * publish that throws leaves it for a retry. The copy is idempotent on its
 * canvas documents (`ON CONFLICT DO NOTHING`).
 */

import {
  createLogger,
  publishProjectConnectionsClose,
  type Redis,
} from "@breatic/core";
import type { ProjectConnectionsCloseReason, ProjectLifecycleEvent } from "@breatic/shared";
import {
  startGroupConsumer,
  type EntryOutcome,
  type GroupConsumer,
  type GroupConsumerSettings,
} from "@collab/services/stream-group-consumer.js";
import * as yjsDocumentsRepo from "@collab/services/yjs-documents.repo.js";

const logger = createLogger("lifecycle-listener");

/** Consumer group every collab instance joins for lifecycle commands. */
export const LIFECYCLE_GROUP = "collab-lifecycle";

/** Asks every instance to close its connections to a project. */
export type PublishConnectionsClose = (
  projectId: string,
  reason: ProjectConnectionsCloseReason,
) => Promise<void>;

/**
 * Do the once-only part of one command and ask every instance to close the
 * project's connections.
 *
 * Exported for unit testing without a stream.
 * @param event - The command read off the stream.
 * @param publish - Publishes the close request.
 * @throws {Error} When the copy or the publish fails; the consumer retries.
 */
export async function handleLifecycleEvent(
  event: ProjectLifecycleEvent,
  publish: PublishConnectionsClose,
): Promise<void> {
  if (event.type === "project:duplicated") {
    await yjsDocumentsRepo.duplicateByProjectPrefix(event.sourceId, event.newId);
    await publish(event.newId, "content-updated");
    logger.info({ sourceId: event.sourceId, newId: event.newId }, "project_duplicated_copy_handled");
    return;
  }
  if (event.type === "project:archived") {
    await publish(event.projectId, "archived");
    logger.info({ projectId: event.projectId }, "project_archived_close_requested");
    return;
  }
  if (event.type === "project:restored") {
    await publish(event.projectId, "restored");
    logger.info({ projectId: event.projectId }, "project_restored_close_requested");
    return;
  }
  // An unknown command type is skipped rather than retried, so one bad event
  // can't block the stream.
  logger.warn({ type: (event as { type?: string }).type }, "unknown_lifecycle_event_type");
}

/**
 * Read one entry's payload as a lifecycle command.
 * @param payload - The entry's `payload` field.
 * @returns The command, or null when it is not a JSON object.
 */
function readLifecycleEvent(payload: string | undefined): ProjectLifecycleEvent | null {
  let event: unknown;
  try {
    event = JSON.parse(payload ?? "");
  } catch {
    return null;
  }
  return typeof event === "object" && event !== null ? (event as ProjectLifecycleEvent) : null;
}

/** What the lifecycle listener needs. */
export interface LifecycleListenerDeps {
  /** Redis URL of the stream database (DB2). */
  streamUrl: string;
  /** Lifecycle stream key. */
  streamKey: string;
  /** Where the single-instance reader kept its position. */
  legacyCursorKey: string;
  /** `REDIS_KEY_PREFIX`, namespacing the failure counts. */
  keyPrefix: string;
  /** This process's consumer name. */
  instanceId: string;
  /** Coordination database client (DB3). */
  coordination: Redis;
  /** Timing and limits. */
  settings: GroupConsumerSettings;
  /** Publishes the close request; the core publisher in production. */
  publish?: PublishConnectionsClose;
}

/**
 * Start consuming project-lifecycle commands.
 * @param deps - Stream, names, coordination client and settings.
 * @returns The running consumer.
 */
export function startLifecycleListener(deps: LifecycleListenerDeps): GroupConsumer {
  const publish = deps.publish ?? publishProjectConnectionsClose;
  return startGroupConsumer({
    streamUrl: deps.streamUrl,
    streamKey: deps.streamKey,
    group: LIFECYCLE_GROUP,
    consumer: deps.instanceId,
    legacyCursorKey: deps.legacyCursorKey,
    failuresKey: `${deps.keyPrefix}:collab:lifecycle-event-failures`,
    coordination: deps.coordination,
    settings: deps.settings,
    // One key: one command at a time; a failing one retries after the later ones.
    keyOf: () => "lifecycle",
    process: async (entries, control) => {
      const outcomes = new Map<string, EntryOutcome>();
      for (const entry of entries) {
        if (control.stopping()) break;
        const event = readLifecycleEvent(entry.payload);
        if (!event) {
          logger.error({ id: entry.id, raw: entry.payload }, "lifecycle_event_unparseable_skipped");
          outcomes.set(entry.id, "done");
          continue;
        }
        try {
          await handleLifecycleEvent(event, publish);
          outcomes.set(entry.id, "done");
        } catch (err) {
          logger.error({ err, id: entry.id, type: event.type }, "lifecycle_event_failed");
          outcomes.set(entry.id, { failed: err });
        }
      }
      return outcomes;
    },
  });
}
