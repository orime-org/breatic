// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Transactional-outbox repository for project-lifecycle commands.
 *
 * The Yjs document store lives in a SEPARATE Postgres database, so what a
 * project duplicate / archive / restore needs on the collab side cannot run
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

/** What one forward did: the row it took and, when the publish threw, why. */
export interface ForwardResult {
  /** Outbox row id. */
  id: string;
  /** The publish error; absent when the row was marked sent. */
  error?: unknown;
}

/**
 * Forward the oldest unsent row, in a transaction of its own (inner#1497 §6.3).
 *
 * `FOR UPDATE SKIP LOCKED` lets several server instances drain the outbox at
 * once: each takes a row no other open transaction holds, so no two instances
 * publish the same row; a crash between a row's publish and its commit
 * publishes it again. A publish that throws leaves the row unsent with its
 * attempt count raised, both written by this same transaction.
 * @param publish - Sends the event to the lifecycle stream.
 * @returns The row it took, or null when nothing is unsent.
 * @throws {Error} When the outbox transaction itself fails.
 */
export async function forwardNextUnsent(
  publish: (event: ProjectLifecycleEvent) => Promise<void>,
): Promise<ForwardResult | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: projectLifecycleOutbox.id, payload: projectLifecycleOutbox.payload })
      .from(projectLifecycleOutbox)
      .where(isNull(projectLifecycleOutbox.sentAt))
      .orderBy(asc(projectLifecycleOutbox.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!row) return null;
    try {
      await publish(row.payload as ProjectLifecycleEvent);
    } catch (error) {
      await tx
        .update(projectLifecycleOutbox)
        .set({ attempts: sql`${projectLifecycleOutbox.attempts} + 1` })
        .where(eq(projectLifecycleOutbox.id, row.id));
      return { id: row.id, error };
    }
    await tx
      .update(projectLifecycleOutbox)
      .set({ sentAt: new Date() })
      .where(eq(projectLifecycleOutbox.id, row.id));
    return { id: row.id };
  });
}
