// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A region's outbox to the global region (inner#1955): directory changes
 * written in the same transaction as the business write they describe, and
 * relayed in id order.
 */

import { and, asc, eq, isNull } from "drizzle-orm";
import { db, type DbTx } from "@core/db/client.js";
import { regionOutbox, regionOutboxDeadLetters } from "@core/db/schema.js";

/** An event as the relay sends it. */
export interface OutboxRow {
  id: number;
  aggregateKey: string;
  eventType: string;
  payload: unknown;
}

/**
 * Write one event in the caller's transaction.
 * @param event - The aggregate it orders under, its type and its content.
 * @param event.aggregateKey - The key events are ordered by, such as `studio:{id}`.
 * @param event.eventType - What happened.
 * @param event.payload - The facts the global region applies.
 * @param tx - The business transaction; the write runs on its own when absent.
 */
export async function append(
  event: { aggregateKey: string; eventType: string; payload: Record<string, unknown> },
  tx?: DbTx,
): Promise<void> {
  await (tx ?? db).insert(regionOutbox).values(event);
}

/**
 * The unsent events, oldest first.
 * @param limit - How many to take.
 * @returns The events.
 */
export async function listUnsent(limit: number): Promise<OutboxRow[]> {
  return db
    .select({
      id: regionOutbox.id,
      aggregateKey: regionOutbox.aggregateKey,
      eventType: regionOutbox.eventType,
      payload: regionOutbox.payload,
    })
    .from(regionOutbox)
    .where(isNull(regionOutbox.sentAt))
    .orderBy(asc(regionOutbox.id))
    .limit(limit);
}

/**
 * Whether any event filed under a key is still unsent.
 * @param aggregateKey - The key, such as `studio:{id}`.
 * @returns True when one is.
 */
export async function hasUnsent(aggregateKey: string): Promise<boolean> {
  const [row] = await db
    .select({ id: regionOutbox.id })
    .from(regionOutbox)
    .where(and(eq(regionOutbox.aggregateKey, aggregateKey), isNull(regionOutbox.sentAt)))
    .limit(1);
  return row !== undefined;
}

/**
 * Mark an event confirmed by the global region.
 * @param id - The event.
 */
export async function markSent(id: number): Promise<void> {
  await db.update(regionOutbox).set({ sentAt: new Date() }).where(and(eq(regionOutbox.id, id), isNull(regionOutbox.sentAt)));
}

/**
 * Set aside an event the global region can never apply, and mark it handled.
 * @param id - The event.
 * @param reason - Why the global region refused it.
 */
export async function deadLetter(id: number, reason: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(regionOutboxDeadLetters).values({ outboxId: id, reason }).onConflictDoNothing();
    await tx.update(regionOutbox).set({ sentAt: new Date() }).where(eq(regionOutbox.id, id));
  });
}
