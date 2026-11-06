// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** Single insertion boundary for durable account interaction history. */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, type DbTx } from "@core/db/client.js";
import { accountActivityEvents } from "@core/db/schema.js";
import type { AccountActivityEntity, AccountActivityKind } from "@breatic/shared";

/** Only authenticated application callers supply the actor and server time. */
export interface NewAccountActivity {
  userId: string;
  projectId: string | null;
  kind: AccountActivityKind;
  occurredAt?: Date;
  visitId?: string;
}
/** A visit claim distinguishes the original insertion from an exact replay. */
export interface RecordedAccountActivity {
  activity: AccountActivityEntity;
  inserted: boolean;
}

/** SQL renders UTC microseconds before postgres.js can turn them into Date. */
const activityColumns = {
  id: accountActivityEvents.id,
  userId: accountActivityEvents.userId,
  projectId: accountActivityEvents.projectId,
  kind: accountActivityEvents.kind,
  visitId: accountActivityEvents.visitId,
  occurredAt: sql<string>`to_char(${accountActivityEvents.occurredAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
};

/**
 * Look up an authenticated account's own immutable original visit.
 * @param userId - Trusted session account.
 * @param visitId - Validated original page-entry UUID.
 * @param tx - Optional enclosing business transaction.
 * @returns Its original event, or null without revealing another account.
 * @throws {Error} When the database cannot answer.
 */
export async function findVisit(userId: string, visitId: string, tx?: DbTx): Promise<AccountActivityEntity | null> {
  const rows = await (tx ?? db).select(activityColumns).from(accountActivityEvents).where(and(
    eq(accountActivityEvents.userId, userId), eq(accountActivityEvents.visitId, visitId),
    isNull(accountActivityEvents.deletedAt),
  )).limit(1);
  return rows[0] ?? null;
}

/**
 * Append an accepted interaction in the caller's business transaction.
 * A unique visit INSERT claims admission; a competing insertion is read in a
 * subsequent statement so READ COMMITTED sees the committed original row.
 * @param input - Trusted actor, authorized Project and accepted activity.
 * @param tx - Existing transaction when a business row changes with the event.
 * @returns The original event and whether this caller inserted it.
 * @throws {Error} When persistence or a required database constraint fails.
 */
export async function recordActivity(input: NewAccountActivity, tx?: DbTx): Promise<RecordedAccountActivity> {
  const rows = await (tx ?? db).insert(accountActivityEvents).values({
    userId: input.userId, projectId: input.projectId, kind: input.kind,
    occurredAt: input.occurredAt ?? new Date(), visitId: input.visitId ?? null,
  }).onConflictDoNothing({ target: [accountActivityEvents.userId, accountActivityEvents.visitId] }).returning(activityColumns);
  if (rows[0]) return { activity: rows[0], inserted: true };
  if (input.visitId) {
    const original = await findVisit(input.userId, input.visitId, tx);
    if (original) return { activity: original, inserted: false };
  }
  throw new Error("Account activity insertion returned no original event");
}
