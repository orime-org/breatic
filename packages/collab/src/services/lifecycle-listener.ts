// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Project-lifecycle event listener backed by Redis Streams.
 *
 * Consumes `ProjectLifecycleEvent` commands from the
 * `${env}:stream:project-lifecycle` stream (forwarded by the server's
 * transactional-outbox relay) and performs the yjs-DB side that can no
 * longer ride the server's business transaction:
 *
 *   - `project:deleted`    → soft-delete every `project-{id}/*` doc in
 *                            the yjs DB + close live connections (a stale
 *                            tab can't keep writing a deleted project).
 *   - `project:duplicated` → copy `project-{src}/*` → `project-{new}/*`
 *                            in the yjs DB + close the new project's
 *                            connections so a client that raced in and
 *                            lazy-seeded a default meta reloads the
 *                            copied source content.
 *
 * Durable resume — the last handled stream id is persisted to Redis so
 * a collab restart never drops an in-flight command (a dropped delete =
 * data leak, a dropped duplicate = empty project). Handlers are
 * idempotent (the repo's `deleted_at IS NULL` guard + `ON CONFLICT`),
 * so at-least-once redelivery is safe; a transient DB error throws and
 * the consumer retries.
 */

import type { Hocuspocus } from "@hocuspocus/server";
import { lifecycleStreamKey } from "@breatic/core";
import { parseDocName, type ProjectLifecycleEvent } from "@breatic/shared";
import { startStreamConsumer } from "@collab/services/event-stream.js";
import * as yjsDocumentsRepo from "@collab/services/yjs-documents.repo.js";
import { createLogger } from "@collab/infra/logger.js";

const logger = createLogger("lifecycle-listener");

/**
 * WebSocket close codes for the lifecycle kick. Distinct from
 * members-sync's 4403 ("permission changed, re-auth"): both of these
 * trigger a client reconnect, after which `onAuthenticate` decides the
 * outcome — a deleted project is refused (project gone), a duplicated
 * project re-loads its now-correct meta.
 */
const CLOSE_PROJECT_DELETED = { code: 4404, reason: "Project deleted" } as const;
const CLOSE_PROJECT_REFRESHED = {
  code: 4406,
  reason: "Project content updated",
} as const;

/**
 * Build the Redis key where this consumer persists its last-handled
 * stream id for durable resume.
 * @param envPrefix - Environment prefix (e.g. `dev`) that namespaces the key
 * @returns The `{envPrefix}:collab:project-lifecycle:last-id` cursor key
 */
function lifecycleLastIdKey(envPrefix: string): string {
  return `${envPrefix}:collab:project-lifecycle:last-id`;
}

/**
 * Close every live connection to any doc under a project (all users).
 *
 * Walks the loaded-document map and filters by the doc-name project id,
 * so meta + every canvas doc of the project are covered. Best-effort:
 * unloaded docs simply have no connections.
 * @param hocuspocus - Running Hocuspocus server whose connections are scanned
 * @param projectId - Project whose docs' connections are closed
 * @param close - Close frame sent to each connection
 * @param close.code - WebSocket close code
 * @param close.reason - Human-readable close reason
 */
function kickAllFromProject(
  hocuspocus: Hocuspocus,
  projectId: string,
  close: { code: number; reason: string },
): void {
  const docs = hocuspocus.documents;
  if (!docs) return;
  for (const [docName, doc] of docs.entries()) {
    const parsed = parseDocName(docName);
    if (!parsed || parsed.projectId !== projectId) continue;
    for (const [, connection] of doc.connections) {
      connection.connection.close({ code: close.code, reason: close.reason });
    }
  }
}

/**
 * Dispatch one lifecycle command to its yjs-DB side + connection kick.
 *
 * A thrown error (transient DB failure) is propagated so the stream
 * consumer leaves the cursor un-advanced and retries; the idempotent
 * repo guards make a redelivery a safe no-op.
 *
 * Exported for unit testing the dispatch + kick without a live stream.
 * @param hocuspocus - Running Hocuspocus server for the connection kick
 * @param event - The lifecycle command read off the stream
 */
export async function handleLifecycleEvent(
  hocuspocus: Hocuspocus,
  event: ProjectLifecycleEvent,
): Promise<void> {
  if (event.type === "project:deleted") {
    await yjsDocumentsRepo.softDeleteByProjectPrefix(event.projectId);
    kickAllFromProject(hocuspocus, event.projectId, CLOSE_PROJECT_DELETED);
    logger.info({ projectId: event.projectId }, "project_deleted_cascade_handled");
    return;
  }
  if (event.type === "project:duplicated") {
    await yjsDocumentsRepo.duplicateByProjectPrefix(event.sourceId, event.newId);
    kickAllFromProject(hocuspocus, event.newId, CLOSE_PROJECT_REFRESHED);
    logger.info(
      { sourceId: event.sourceId, newId: event.newId },
      "project_duplicated_copy_handled",
    );
    return;
  }
  // Forward-compat: an unknown command type is skipped (not retried), so
  // one bad event can't block the stream.
  logger.warn(
    { type: (event as { type?: string }).type },
    "unknown_lifecycle_event_type",
  );
}

/**
 * Start consuming project-lifecycle commands off the Redis stream.
 * @param hocuspocus - Running Hocuspocus server instance
 * @param streamRedisUrl - Redis URL for Streams (DB 2)
 * @param envPrefix - Environment prefix for stream + last-id keys
 * @returns Cleanup function to stop consuming
 */
export function startLifecycleListener(
  hocuspocus: Hocuspocus,
  streamRedisUrl: string,
  envPrefix: string,
): () => Promise<void> {
  const streamKey = lifecycleStreamKey();
  const lastIdKey = lifecycleLastIdKey(envPrefix);

  logger.info({ streamKey }, "Project lifecycle listener starting");

  const stopStream = startStreamConsumer<ProjectLifecycleEvent>({
    redisUrl: streamRedisUrl,
    streamKey,
    lastIdKey,
    parse: (raw) => JSON.parse(raw) as ProjectLifecycleEvent,
    handle: (event) => handleLifecycleEvent(hocuspocus, event),
  });

  return async () => {
    await stopStream();
    logger.info("Project lifecycle listener stopped");
  };
}
