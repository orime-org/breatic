// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The `oauth_records` table (#1488): the store behind server's oidc-provider
 * adapter. The first six functions map one to one onto the adapter interface;
 * the rest answer the grant questions `agentAccessService` asks.
 *
 * Expiry is always compared against the caller's `now`, never the database
 * clock, so a check can be asked about a moment ahead. A destroyed record is
 * soft-deleted; the live-only unique index then lets the same model and id be
 * stored again.
 */

import { and, eq, exists, gt, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { OAuthRecordEntity } from "@breatic/shared";
import { db } from "@core/db/client.js";
import { oauthRecords } from "@core/db/schema.js";

/** A grant that can still be used, and whose authorization it is. */
export interface UsableGrant {
  grantId: string;
  accountId: string | null;
  clientId: string | null;
}

/**
 * Reads a string field of an adapter payload.
 * @param payload - The stored payload.
 * @param key - The field.
 * @returns The value when it is a string, otherwise null.
 */
function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

/**
 * The condition "not destroyed and not expired at `now`" on a records table or alias.
 * @param table - The table or its alias.
 * @param table.deletedAt - Its `deleted_at` column.
 * @param table.expiresAt - Its `expires_at` column.
 * @param now - The caller's clock.
 * @returns The condition.
 */
function liveAt(table: { deletedAt: AnyPgColumn; expiresAt: AnyPgColumn }, now: Date): SQL | undefined {
  return and(isNull(table.deletedAt), or(isNull(table.expiresAt), gt(table.expiresAt, now)));
}

/**
 * Stores a record, replacing the live one with the same model and id. The
 * lookup columns are copied out of the payload; a Grant is its own grant.
 * @param model - The adapter model name (`Grant`, `RefreshToken`, ...).
 * @param id - The record id.
 * @param payload - What oidc-provider stores.
 * @param expiresInSeconds - Lifetime from now; omitted never expires.
 * @param now - The caller's clock.
 * @throws {Error} When the database write fails.
 */
export async function upsert(
  model: string,
  id: string,
  payload: Record<string, unknown>,
  expiresInSeconds?: number,
  now: Date = new Date(),
): Promise<void> {
  const columns = {
    payload,
    grantId: model === "Grant" ? id : stringField(payload, "grantId"),
    accountId: stringField(payload, "accountId"),
    clientId: stringField(payload, "clientId"),
    uid: stringField(payload, "uid"),
    expiresAt: expiresInSeconds === undefined ? null : new Date(now.getTime() + expiresInSeconds * 1000),
  };
  await db
    .insert(oauthRecords)
    .values({ model, recordId: id, ...columns })
    .onConflictDoUpdate({
      target: [oauthRecords.model, oauthRecords.recordId],
      targetWhere: isNull(oauthRecords.deletedAt),
      set: { ...columns, updatedAt: sql`now()` },
    });
}

/**
 * Finds a live record by model and id.
 * @param model - The adapter model name.
 * @param id - The record id.
 * @param now - The caller's clock.
 * @returns The record, or undefined when absent, destroyed or expired at `now`.
 * @throws {Error} When the database read fails.
 */
export async function find(model: string, id: string, now: Date = new Date()): Promise<OAuthRecordEntity | undefined> {
  const [row] = await db
    .select({ payload: oauthRecords.payload, consumedAt: oauthRecords.consumedAt, expiresAt: oauthRecords.expiresAt })
    .from(oauthRecords)
    .where(and(eq(oauthRecords.model, model), eq(oauthRecords.recordId, id), liveAt(oauthRecords, now)))
    .limit(1);
  return row;
}

/**
 * Finds a live record by model and uid (sessions and interactions).
 * @param model - The adapter model name.
 * @param uid - The record's uid.
 * @param now - The caller's clock.
 * @returns The record, or undefined when absent, destroyed or expired at `now`.
 * @throws {Error} When the database read fails.
 */
export async function findByUid(model: string, uid: string, now: Date = new Date()): Promise<OAuthRecordEntity | undefined> {
  const [row] = await db
    .select({ payload: oauthRecords.payload, consumedAt: oauthRecords.consumedAt, expiresAt: oauthRecords.expiresAt })
    .from(oauthRecords)
    .where(and(eq(oauthRecords.model, model), eq(oauthRecords.uid, uid), liveAt(oauthRecords, now)))
    .limit(1);
  return row;
}

/**
 * Records that a record was used up; only the first consumption is kept.
 * @param model - The adapter model name.
 * @param id - The record id.
 * @throws {Error} When the database write fails.
 */
export async function consume(model: string, id: string): Promise<void> {
  await db
    .update(oauthRecords)
    .set({ consumedAt: sql`now()` })
    .where(and(eq(oauthRecords.model, model), eq(oauthRecords.recordId, id), isNull(oauthRecords.deletedAt), isNull(oauthRecords.consumedAt)));
}

/**
 * Soft-deletes a record.
 * @param model - The adapter model name.
 * @param id - The record id.
 * @throws {Error} When the database write fails.
 */
export async function destroy(model: string, id: string): Promise<void> {
  await db
    .update(oauthRecords)
    .set({ deletedAt: sql`now()` })
    .where(and(eq(oauthRecords.model, model), eq(oauthRecords.recordId, id), isNull(oauthRecords.deletedAt)));
}

/**
 * Soft-deletes every record of a grant, the Grant record included.
 * @param grantId - The grant id.
 * @throws {Error} When the database write fails.
 */
export async function revokeByGrantId(grantId: string): Promise<void> {
  await db
    .update(oauthRecords)
    .set({ deletedAt: sql`now()` })
    .where(and(eq(oauthRecords.grantId, grantId), isNull(oauthRecords.deletedAt)));
}

/**
 * Grants that can still be used at `now`: the Grant record is live and holds
 * at least one live, unconsumed refresh token or live access token.
 * @param filter - One grant by id, or every grant one account gave (to one client).
 * @param now - The caller's clock.
 * @returns The usable grants matching the filter.
 * @throws {Error} When the database read fails.
 */
export async function usableGrants(
  filter: { grantId: string } | { accountId: string; clientId?: string },
  now: Date = new Date(),
): Promise<UsableGrant[]> {
  const token = alias(oauthRecords, "token");
  const match = "grantId" in filter
    ? eq(oauthRecords.recordId, filter.grantId)
    : and(
      eq(oauthRecords.accountId, filter.accountId),
      filter.clientId === undefined ? undefined : eq(oauthRecords.clientId, filter.clientId),
    );
  return db
    .select({ grantId: oauthRecords.recordId, accountId: oauthRecords.accountId, clientId: oauthRecords.clientId })
    .from(oauthRecords)
    .where(and(
      eq(oauthRecords.model, "Grant"),
      match,
      liveAt(oauthRecords, now),
      exists(
        db.select({ one: sql`1` }).from(token).where(and(
          eq(token.grantId, oauthRecords.recordId),
          liveAt(token, now),
          or(and(eq(token.model, "RefreshToken"), isNull(token.consumedAt)), eq(token.model, "AccessToken")),
        )),
      ),
    ));
}

/**
 * Every grant record not yet destroyed that one account gave one client, expired ones included.
 * @param accountId - Who authorized.
 * @param clientId - The client.
 * @returns The grant ids.
 * @throws {Error} When the database read fails.
 */
export async function grantIdsOf(accountId: string, clientId: string): Promise<string[]> {
  const rows = await db
    .select({ grantId: oauthRecords.recordId })
    .from(oauthRecords)
    .where(and(
      eq(oauthRecords.model, "Grant"),
      eq(oauthRecords.accountId, accountId),
      eq(oauthRecords.clientId, clientId),
      isNull(oauthRecords.deletedAt),
    ));
  return rows.map((r) => r.grantId);
}

/**
 * Who gave a grant not yet destroyed, expired or not.
 * @param grantId - The grant id.
 * @returns The account and client, or undefined when no such grant is left.
 * @throws {Error} When the database read fails.
 */
export async function grantOwner(grantId: string): Promise<{ accountId: string | null; clientId: string | null } | undefined> {
  const [row] = await db
    .select({ accountId: oauthRecords.accountId, clientId: oauthRecords.clientId })
    .from(oauthRecords)
    .where(and(eq(oauthRecords.model, "Grant"), eq(oauthRecords.recordId, grantId), isNull(oauthRecords.deletedAt)))
    .limit(1);
  return row;
}
