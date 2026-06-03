// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Transactional-outbox repository for project-lifecycle commands.
 *
 * The Yjs document store lives in a SEPARATE Postgres database, so a
 * project delete / duplicate can no longer cascade to `yjs_documents`
 * inside the business transaction. Instead the business write and an
 * outbox row are committed together here (atomic "command exists ⇔
 * business write happened"); the relay ({@link ./lifecycle-relay.ts})
 * forwards unsent rows to the `project-lifecycle` Redis Stream, and
 * collab consumes them to perform the yjs-DB side idempotently.
 *
 * `project_lifecycle_outbox` is a business-DB table written only by the
 * server, so its repo lives in `@server` (the schema + migration stay
 * in core like every business table).
 */

import { asc, eq, isNull, sql } from "drizzle-orm";
import { db, projectLifecycleOutbox } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import type { ProjectLifecycleEvent } from "@breatic/shared";

/** An unsent outbox row ready for the relay to forward. */
export interface OutboxRow {
  id: string;
  event: ProjectLifecycleEvent;
}

/**
 * Append a lifecycle command to the outbox inside the caller's business
 * transaction, so the command's existence is atomic with the business
 * write (the project soft-delete / duplicate row).
 * @param tx - Drizzle transaction handle from the surrounding
 *   `db.transaction(async tx => ...)` block
 * @param event - The lifecycle command to enqueue
 */
export async function insertOutboxEvent(
  tx: DbTx,
  event: ProjectLifecycleEvent,
): Promise<void> {
  await tx.insert(projectLifecycleOutbox).values({
    kind: event.type,
    payload: event,
  });
}

/**
 * Read the oldest still-unsent outbox rows (relay drain batch).
 * @param limit - Max rows to claim this pass
 * @returns Unsent rows, oldest first, with the payload typed as the event
 */
export async function readUnsentEvents(limit: number): Promise<OutboxRow[]> {
  const rows = await db
    .select({
      id: projectLifecycleOutbox.id,
      payload: projectLifecycleOutbox.payload,
    })
    .from(projectLifecycleOutbox)
    .where(isNull(projectLifecycleOutbox.sentAt))
    .orderBy(asc(projectLifecycleOutbox.createdAt))
    .limit(limit);
  return rows.map((r) => ({ id: r.id, event: r.payload as ProjectLifecycleEvent }));
}

/**
 * Mark an outbox row as forwarded so the relay never re-publishes it.
 * @param id - Outbox row id
 */
export async function markSent(id: string): Promise<void> {
  await db
    .update(projectLifecycleOutbox)
    .set({ sentAt: new Date() })
    .where(eq(projectLifecycleOutbox.id, id));
}

/**
 * Bump the attempt counter after a failed forward (diagnostics + future
 * dead-letter thresholds). The row stays unsent so the relay retries.
 * @param id - Outbox row id
 */
export async function bumpAttempts(id: string): Promise<void> {
  await db
    .update(projectLifecycleOutbox)
    .set({ attempts: sql`${projectLifecycleOutbox.attempts} + 1` })
    .where(eq(projectLifecycleOutbox.id, id));
}
