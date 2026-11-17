// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Account provider keys repository — data access for `account_provider_keys` (inner#1953), a global table: the only
 * place an account's own upstream key is kept, sealed. Replacing, deleting or erasing a key clears its sealed text and
 * soft-deletes its row in one write, so a task still naming the row by id reads nothing. Nothing this module returns
 * for display carries the sealed text; only {@link sealedKeyById} does, for the caller that opens it.
 */

import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { TransactionSql } from "postgres";
import type { AccountProviderKey, ProviderKeyBalanceState } from "@breatic/shared";
import { db, type DbTx } from "@core/db/client.js";
import { accountProviderKeys, users } from "@core/db/schema.js";
import { dropChoicesForUpstream } from "@core/byok/account-model-upstreams.repo.js";

/** What a check of the key found, stored beside it. */
export interface ProviderKeyCheckRecord {
  connected: boolean;
  balanceState: ProviderKeyBalanceState | null;
  balanceAmount: number | null;
  balanceCurrency: string | null;
  /** Why it did not connect; null when it did. */
  failure: string | null;
  /** Whether the key can read the actual costs of its calls; null where the upstream has no such probe. */
  costsReadable?: boolean | null;
}

/** A key to save: already checked by the caller and sealed. */
export interface NewAccountProviderKey {
  userId: string;
  upstream: string;
  ciphertext: string;
  displayHint: string;
  /** The check made before saving, when there was one. */
  check?: ProviderKeyCheckRecord;
}

/** A live key's sealed text, for the caller that opens it. */
export interface SealedProviderKey {
  id: string;
  userId: string;
  upstream: string;
  ciphertext: string;
}

const entityColumns = {
  id: accountProviderKeys.id,
  userId: accountProviderKeys.userId,
  upstream: accountProviderKeys.upstream,
  displayHint: accountProviderKeys.displayHint,
  lastCheckedAt: accountProviderKeys.lastCheckedAt,
  lastConnected: accountProviderKeys.lastConnected,
  lastBalanceAmount: accountProviderKeys.lastBalanceAmount,
  lastBalanceCurrency: accountProviderKeys.lastBalanceCurrency,
  lastBalanceState: accountProviderKeys.lastBalanceState,
  lastFailure: accountProviderKeys.lastFailure,
  lastCostsReadable: accountProviderKeys.lastCostsReadable,
  createdAt: accountProviderKeys.createdAt,
  updatedAt: accountProviderKeys.updatedAt,
};

/**
 * Map a selected row to the entity.
 * @param row - The row, selected with `entityColumns`.
 * @param row.lastBalanceAmount - The stored balance, as Postgres numeric text.
 * @returns The entity.
 */
function toEntity(row: Omit<AccountProviderKey, "lastBalanceAmount"> & { lastBalanceAmount: string | null }): AccountProviderKey {
  return { ...row, lastBalanceAmount: row.lastBalanceAmount === null ? null : Number(row.lastBalanceAmount) };
}

/**
 * The check columns for a check record.
 * @param check - What the check found.
 * @returns The column values.
 */
function checkColumns(check: ProviderKeyCheckRecord): Partial<typeof accountProviderKeys.$inferInsert> {
  return {
    lastCheckedAt: new Date(),
    lastConnected: check.connected,
    lastBalanceState: check.balanceState,
    lastBalanceAmount: check.balanceAmount === null ? null : String(check.balanceAmount),
    lastBalanceCurrency: check.balanceCurrency,
    lastFailure: check.failure,
    lastCostsReadable: check.costsReadable ?? null,
  };
}

/**
 * Serialise every key write of one account: two replacements of the same key would otherwise both retire the old
 * row and the second insert would hit the live-uniqueness index.
 * @param tx - The open transaction.
 * @param userId - The account.
 * @returns Nothing.
 */
async function lockAccount(tx: DbTx, userId: string): Promise<void> {
  await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("no key update");
}

/**
 * Save an account's key for an upstream, replacing the live one: in one transaction the old row's sealed text is
 * cleared and the row soft-deleted, and a new row is inserted.
 * @param input - The key.
 * @returns The saved key, without its sealed text.
 * @throws {Error} When the account does not exist (foreign key).
 */
export async function saveKey(input: NewAccountProviderKey): Promise<AccountProviderKey> {
  return db.transaction(async (tx) => {
    await lockAccount(tx, input.userId);
    await tx
      .update(accountProviderKeys)
      .set({ ciphertext: null, deletedAt: sql`now()` })
      .where(and(eq(accountProviderKeys.userId, input.userId), eq(accountProviderKeys.upstream, input.upstream), isNull(accountProviderKeys.deletedAt)));
    const rows = await tx
      .insert(accountProviderKeys)
      .values({
        userId: input.userId,
        upstream: input.upstream,
        ciphertext: input.ciphertext,
        displayHint: input.displayHint,
        ...(input.check === undefined ? {} : checkColumns(input.check)),
      })
      .returning(entityColumns);
    return toEntity(rows[0]!);
  });
}

/**
 * Store what a later check of a live key found.
 * @param userId - The account.
 * @param upstream - The upstream.
 * @param check - What the check found.
 * @returns The key as now stored, or null when the account has no live key there.
 */
export async function recordCheck(userId: string, upstream: string, check: ProviderKeyCheckRecord): Promise<AccountProviderKey | null> {
  const rows = await db
    .update(accountProviderKeys)
    .set(checkColumns(check))
    .where(and(eq(accountProviderKeys.userId, userId), eq(accountProviderKeys.upstream, upstream), isNull(accountProviderKeys.deletedAt)))
    .returning(entityColumns);
  return rows[0] === undefined ? null : toEntity(rows[0]);
}

/**
 * An account's live keys, without their sealed text.
 * @param userId - The account.
 * @returns The keys, by upstream.
 */
export async function liveKeysFor(userId: string): Promise<AccountProviderKey[]> {
  const rows = await db
    .select(entityColumns)
    .from(accountProviderKeys)
    .where(and(eq(accountProviderKeys.userId, userId), isNull(accountProviderKeys.deletedAt)))
    .orderBy(asc(accountProviderKeys.upstream));
  return rows.map(toEntity);
}

/**
 * A key row's sealed text, only while the row is live.
 * @param id - The `account_provider_keys` row a task or turn recorded.
 * @returns The sealed key, or null when the row was replaced, deleted, erased or never existed.
 */
export async function sealedKeyById(id: string): Promise<SealedProviderKey | null> {
  const rows = await db
    .select({ id: accountProviderKeys.id, userId: accountProviderKeys.userId, upstream: accountProviderKeys.upstream, ciphertext: accountProviderKeys.ciphertext })
    .from(accountProviderKeys)
    .where(and(eq(accountProviderKeys.id, id), isNull(accountProviderKeys.deletedAt), isNotNull(accountProviderKeys.ciphertext)))
    .limit(1);
  const row = rows[0];
  return row === undefined || row.ciphertext === null ? null : { ...row, ciphertext: row.ciphertext };
}

/**
 * Delete an account's key for an upstream: clear its sealed text and soft-delete the row, and drop the account's
 * model choices that named that upstream, in one transaction.
 * @param userId - The account.
 * @param upstream - The upstream.
 * @returns True when a live key was deleted.
 */
export async function deleteKey(userId: string, upstream: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockAccount(tx, userId);
    const retired = await tx
      .update(accountProviderKeys)
      .set({ ciphertext: null, deletedAt: sql`now()` })
      .where(and(eq(accountProviderKeys.userId, userId), eq(accountProviderKeys.upstream, upstream), isNull(accountProviderKeys.deletedAt)))
      .returning({ id: accountProviderKeys.id });
    if (retired.length === 0) return false;
    await dropChoicesForUpstream(userId, upstream, tx);
    return true;
  });
}

/**
 * Erase deleted accounts' keys inside the account erase's own transaction: every sealed text cleared and every row
 * soft-deleted.
 * @param userIds - The accounts.
 * @param tx - The erase's transaction.
 * @returns Nothing.
 */
export async function eraseForAccounts(userIds: readonly string[], tx: TransactionSql): Promise<void> {
  await tx`
    UPDATE account_provider_keys SET ciphertext = NULL, deleted_at = COALESCE(deleted_at, now()), updated_at = now()
    WHERE user_id = ANY(${[...userIds]}::uuid[]) AND (ciphertext IS NOT NULL OR deleted_at IS NULL)`;
}
