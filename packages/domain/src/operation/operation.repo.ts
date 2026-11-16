// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The `operation_ledger` table's one home (inner#1968, design 3.1): one row
 * per operation an account's monthly allowance counts.
 *
 * Every write is a compare-and-set on `status` (design 5.2 9.5), so a second
 * writer of the same row does nothing; callers hold the account row lock
 * (`lockOperationAccount`) around them.
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, operationLedger } from "@breatic/core";
import type { DbTx } from "@breatic/core";

/** What one account has counted in one period, by slot. */
export interface PeriodCounts {
  /** Counted rows the allowance covered. */
  readonly allowance: number;
  /** Counted rows charged as overage. */
  readonly overage: number;
}

/** The kinds of operation the ledger counts. */
export type OperationKind = "generation" | "tool_run" | "upload" | "url_paste" | "chat_message" | "text_tool" | "timeline";

/** One ledger row, as the service reads it. */
export interface OperationRow {
  readonly operationKey: string;
  readonly kind: string;
  readonly accountUserId: string;
  readonly studioId: string;
  readonly projectId: string | null;
  readonly actorUserId: string;
  readonly status: "reserved" | "deferred" | "counted" | "released";
  readonly admittedAs: "covered" | "held";
  readonly overageHold: string | null;
  readonly assetId: string | null;
  readonly absorbedBy: string | null;
  readonly absorbedHoldReleased: boolean;
  readonly expiresAt: Date;
  readonly inputAssetIds: readonly string[];
}

/** The columns a row is read with. */
type RowColumns = Pick<
  typeof operationLedger,
  "operationKey" | "kind" | "accountUserId" | "studioId" | "projectId" | "actorUserId" | "status" | "admittedAs"
  | "overageHold" | "assetId" | "absorbedBy" | "absorbedHoldReleased" | "expiresAt" | "inputAssetIds"
>;

/**
 * The columns a row is read with; built when called, so importing this module
 * reads nothing from the schema.
 * @returns The selection.
 */
function rowColumns(): RowColumns {
  return {
    operationKey: operationLedger.operationKey,
    kind: operationLedger.kind,
    accountUserId: operationLedger.accountUserId,
    studioId: operationLedger.studioId,
    projectId: operationLedger.projectId,
    actorUserId: operationLedger.actorUserId,
    status: operationLedger.status,
    admittedAs: operationLedger.admittedAs,
    overageHold: operationLedger.overageHold,
    assetId: operationLedger.assetId,
    absorbedBy: operationLedger.absorbedBy,
    absorbedHoldReleased: operationLedger.absorbedHoldReleased,
    expiresAt: operationLedger.expiresAt,
    inputAssetIds: operationLedger.inputAssetIds,
  };
}

/**
 * Narrow a selected row to the entity.
 * @param row - The selected columns.
 * @returns The entity.
 */
function toRow(row: Omit<OperationRow, "status" | "admittedAs"> & { status: string; admittedAs: string }): OperationRow {
  return row as OperationRow;
}

/**
 * A row whose claimant is a live operation (design 21 #4): it settles with
 * that operation, so it neither counts as in flight nor is swept.
 * @returns The SQL condition over the outer `operation_ledger` row.
 */
function claimantLive(): ReturnType<typeof sql> {
  return sql`exists (select 1 from operation_ledger c where c.operation_key = ${operationLedger.absorbedBy} and c.status = 'reserved' and c.expires_at > now())`;
}

/**
 * Count one account's counted operations in the period that starts at `periodStart`.
 * @param accountUserId - Whose allowance.
 * @param periodStart - The period's start, which identifies it.
 * @param tx - Optional transaction handle.
 * @returns The counts by slot.
 */
export async function countInPeriod(accountUserId: string, periodStart: Date, tx?: DbTx): Promise<PeriodCounts> {
  const [row] = await (tx ?? db)
    .select({
      allowance: sql<number>`count(*) filter (where ${operationLedger.slot} = 'allowance')::int`,
      overage: sql<number>`count(*) filter (where ${operationLedger.slot} = 'overage')::int`,
    })
    .from(operationLedger)
    .where(and(
      eq(operationLedger.accountUserId, accountUserId),
      eq(operationLedger.status, "counted"),
      eq(operationLedger.periodStart, periodStart),
    ));
  return { allowance: row?.allowance ?? 0, overage: row?.overage ?? 0 };
}

/**
 * The covered operations still in flight for one account (`C`, design 3.3
 * step 4): reserved or deferred, not expired, admitted as covered, and not
 * claimed by a live operation or by the one being admitted.
 * @param accountUserId - Whose allowance.
 * @param admitting - The key being admitted, whose claims settle with it.
 * @param tx - The admission's transaction.
 * @returns How many.
 */
export async function countCoveredInFlight(accountUserId: string, admitting: string, tx: DbTx): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(operationLedger)
    .where(and(
      eq(operationLedger.accountUserId, accountUserId),
      inArray(operationLedger.status, ["reserved", "deferred"]),
      sql`${operationLedger.expiresAt} > now()`,
      eq(operationLedger.admittedAs, "covered"),
      sql`(${operationLedger.absorbedBy} is null or (${operationLedger.absorbedBy} <> ${admitting} and not ${claimantLive()}))`,
    ));
  return row?.n ?? 0;
}

/**
 * One row by key.
 * @param key - The operation key.
 * @param tx - Optional transaction handle.
 * @returns The row, or null.
 */
export async function findByKey(key: string, tx?: DbTx): Promise<OperationRow | null> {
  const [row] = await (tx ?? db).select(rowColumns()).from(operationLedger).where(eq(operationLedger.operationKey, key));
  return row === undefined ? null : toRow(row);
}

/** A row about to be admitted. */
export interface NewReserved {
  operationKey: string;
  kind: OperationKind;
  accountUserId: string;
  studioId: string;
  projectId: string | null;
  actorUserId: string;
  admittedAs: "covered" | "held";
  overageHold: string | null;
  expiresAt: Date;
  inputAssetIds: string[];
}

/**
 * Write a `reserved` row, unless the key already has one.
 * @param row - The row.
 * @param tx - The admission's transaction.
 * @returns Whether it was written.
 */
export async function insertReserved(row: NewReserved, tx: DbTx): Promise<boolean> {
  const written = await tx
    .insert(operationLedger)
    .values({ ...row, status: "reserved" })
    .onConflictDoNothing({ target: operationLedger.operationKey })
    .returning({ key: operationLedger.operationKey });
  return written.length > 0;
}

/**
 * Admit a released Agent message again under its key (design 3.3 step 3):
 * the row goes back to `reserved` with this admission's terms.
 * @param row - The new terms.
 * @param tx - The admission's transaction.
 * @returns Whether a released row was revived.
 */
export async function reviveReleased(row: NewReserved, tx: DbTx): Promise<boolean> {
  const revived = await tx
    .update(operationLedger)
    .set({
      status: "reserved", admittedAs: row.admittedAs, overageHold: row.overageHold, expiresAt: row.expiresAt,
      inputAssetIds: row.inputAssetIds, accountUserId: row.accountUserId, studioId: row.studioId,
      releasedAt: null, releaseReason: null, updatedAt: sql`now()`,
    })
    .where(and(eq(operationLedger.operationKey, row.operationKey), eq(operationLedger.status, "released")))
    .returning({ key: operationLedger.operationKey });
  return revived.length > 0;
}

/**
 * Claim one unclaimed, unexpired deferred row of an asset for an operation
 * (design 3.2.1), within its studio and account.
 * @param where - The studio, account and asset.
 * @param where.studioId - The operation's studio.
 * @param where.accountUserId - Whose allowance.
 * @param where.assetId - The derived image.
 * @param claimant - The claiming operation's key.
 * @param tx - The admission's transaction.
 * @returns The claimed row, or null when none was claimable.
 */
export async function claimOne(
  where: { studioId: string; accountUserId: string; assetId: string },
  claimant: string,
  tx: DbTx,
): Promise<OperationRow | null> {
  const [row] = await tx
    .update(operationLedger)
    .set({
      absorbedBy: claimant,
      absorbedHoldReleased: sql`${operationLedger.absorbedHoldReleased} or ${operationLedger.admittedAs} = 'held'`,
      updatedAt: sql`now()`,
    })
    .where(eq(operationLedger.id, sql`(select id from operation_ledger
      where status = 'deferred' and absorbed_by is null and expires_at > now()
        and studio_id = ${where.studioId} and account_user_id = ${where.accountUserId} and asset_id = ${where.assetId}
      order by created_at limit 1)`))
    .returning(rowColumns());
  return row === undefined ? null : toRow(row);
}

/**
 * Give back every claim an operation holds; the rows stay deferred and keep
 * whatever hold they already gave back.
 * @param claimant - The operation's key.
 * @param tx - Its release transaction.
 */
export async function unclaim(claimant: string, tx: DbTx): Promise<void> {
  await tx
    .update(operationLedger)
    .set({ absorbedBy: null, updatedAt: sql`now()` })
    .where(and(eq(operationLedger.status, "deferred"), eq(operationLedger.absorbedBy, claimant)));
}

/** Where a count landed. */
export interface CountedAt {
  slot: "allowance" | "overage";
  periodStart: Date;
  countedAt: Date;
}

/**
 * Move a row from `from` to `counted`.
 * @param key - The operation key.
 * @param from - The status it must have: `reserved`, or `deferred` for the sweep.
 * @param at - The slot, period and time.
 * @param tx - The success transaction.
 * @returns The counted row, or null when the compare-and-set missed.
 */
export async function markCounted(key: string, from: "reserved" | "deferred", at: CountedAt, tx: DbTx): Promise<OperationRow | null> {
  const [row] = await tx
    .update(operationLedger)
    .set({ status: "counted", slot: at.slot, periodStart: at.periodStart, countedAt: at.countedAt, updatedAt: sql`now()` })
    .where(and(
      eq(operationLedger.operationKey, key),
      eq(operationLedger.status, from),
      ...(from === "deferred" ? [sql`${operationLedger.expiresAt} <= now()`, sql`not ${claimantLive()}`] : []),
    ))
    .returning(rowColumns());
  return row === undefined ? null : toRow(row);
}

/**
 * Record the overage charge request a count filed.
 * @param key - The operation key.
 * @param chargeRequestId - The request.
 * @param tx - The success transaction.
 */
export async function setChargeRequest(key: string, chargeRequestId: string, tx: DbTx): Promise<void> {
  await tx.update(operationLedger).set({ chargeRequestId }).where(eq(operationLedger.operationKey, key));
}

/**
 * Defer a reserved upload row with the asset it registered (design 3.2.1).
 * @param key - The operation key.
 * @param assetId - The registered image.
 * @param tx - The success transaction.
 * @returns The deferred row, or null when the compare-and-set missed.
 */
export async function markDeferred(key: string, assetId: string, tx: DbTx): Promise<OperationRow | null> {
  const [row] = await tx
    .update(operationLedger)
    .set({ status: "deferred", assetId, updatedAt: sql`now()` })
    .where(and(eq(operationLedger.operationKey, key), eq(operationLedger.status, "reserved")))
    .returning(rowColumns());
  return row === undefined ? null : toRow(row);
}

/**
 * Write the asset a counted upload registered.
 * @param key - The operation key.
 * @param assetId - The asset.
 * @param tx - The success transaction.
 */
export async function setAsset(key: string, assetId: string, tx: DbTx): Promise<void> {
  await tx.update(operationLedger).set({ assetId }).where(and(eq(operationLedger.operationKey, key), isNull(operationLedger.assetId)));
}

/**
 * Release a reserved row.
 * @param key - The operation key.
 * @param reason - Why.
 * @param tx - The failure transaction.
 * @returns The released row, or null when the compare-and-set missed.
 */
export async function markReleased(key: string, reason: string, tx: DbTx): Promise<OperationRow | null> {
  const [row] = await tx
    .update(operationLedger)
    .set({ status: "released", releasedAt: sql`now()`, releaseReason: reason.slice(0, 32), updatedAt: sql`now()` })
    .where(and(eq(operationLedger.operationKey, key), eq(operationLedger.status, "reserved")))
    .returning(rowColumns());
  return row === undefined ? null : toRow(row);
}

/**
 * Use up every still-deferred row of a counted operation's inputs, within its
 * studio and account, whoever claimed them (design 3.2.1).
 * @param counted - The counted operation.
 * @param tx - Its success transaction.
 * @returns The rows released as `absorbed`.
 */
export async function markAbsorbed(counted: OperationRow, tx: DbTx): Promise<OperationRow[]> {
  if (counted.inputAssetIds.length === 0) return [];
  const rows = await tx
    .update(operationLedger)
    .set({ status: "released", releaseReason: "absorbed", releasedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(
      eq(operationLedger.status, "deferred"),
      inArray(operationLedger.assetId, [...counted.inputAssetIds]),
      eq(operationLedger.studioId, counted.studioId),
      eq(operationLedger.accountUserId, counted.accountUserId),
    ))
    .returning(rowColumns());
  return rows.map(toRow);
}

/**
 * Deferred rows the sweep may count: expired, and not claimed by a live operation.
 * @param limit - How many at most.
 * @returns Their keys and accounts, oldest expiry first.
 */
export async function listSweepable(limit: number): Promise<Array<{ operationKey: string; accountUserId: string }>> {
  return db
    .select({ operationKey: operationLedger.operationKey, accountUserId: operationLedger.accountUserId })
    .from(operationLedger)
    .where(and(eq(operationLedger.status, "deferred"), sql`${operationLedger.expiresAt} <= now()`, sql`not ${claimantLive()}`))
    .orderBy(operationLedger.expiresAt)
    .limit(limit);
}

/**
 * Keep a reserved row in flight until a later moment, once it is due: only
 * a row expiring before `dueBefore` is written, so frequent renewals cost
 * one write per half lease.
 * @param key - The operation key.
 * @param until - The new expiry.
 * @param dueBefore - Renew only a row expiring before this moment.
 * @param tx - Optional transaction handle.
 * @returns Whether a reserved row was extended.
 */
export async function extend(key: string, until: Date, dueBefore: Date, tx?: DbTx): Promise<boolean> {
  const rows = await (tx ?? db)
    .update(operationLedger)
    .set({ expiresAt: until, updatedAt: sql`now()` })
    .where(and(eq(operationLedger.operationKey, key), eq(operationLedger.status, "reserved"), sql`${operationLedger.expiresAt} < ${dueBefore}`))
    .returning({ key: operationLedger.operationKey });
  return rows.length > 0;
}
