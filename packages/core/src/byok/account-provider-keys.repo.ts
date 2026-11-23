// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Account provider keys repository — data access for `account_provider_keys` (inner#1953): the only
 * place an account's own upstream key is kept, sealed. Replacing, deleting or erasing a key clears its sealed text and
 * soft-deletes its row in one write, so a task still naming the row by id reads no sealed text. Nothing this module
 * returns for display carries the sealed text; only {@link keyRowById} and {@link sealedLiveKeyFor} do, for the caller
 * that opens it.
 */

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { TransactionSql } from "postgres";
import type { AccountProviderKey, ProviderKeyBalanceState } from "@breatic/shared";
import { db } from "@core/db/client.js";
import { accountProviderKeys, users } from "@core/db/schema.js";
import { lockAccountRow } from "@core/auth/membership.repo.js";
import { dropChoicesForUpstream } from "@core/byok/account-model-upstreams.repo.js";
import { redactSessionError } from "@core/infra/session-error.js";

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
 * Save an account's key for an upstream, replacing the live one: in one transaction the old row's sealed text is
 * cleared and the row soft-deleted, and a new row is inserted.
 * @param input - The key.
 * @returns The saved key, without its sealed text.
 * @throws {Error} When no live account has the id, or the write fails; the error never carries the sealed text.
 */
export async function saveKey(input: NewAccountProviderKey): Promise<AccountProviderKey> {
  try {
    return await db.transaction(async (tx) => {
      await lockAccountRow(input.userId, tx);
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
  } catch (err) {
    // A failed query's error repeats its parameters, the sealed key among them; only the redacted copy leaves here.
    throw redactSessionError(err, [input.ciphertext]);
  }
}

/**
 * Record what checking a key found on the row that was checked, while it is live.
 * @param id - The row that was checked.
 * @param check - What the check found.
 * @returns The key as now stored, or null when the row was replaced or deleted meanwhile.
 */
export async function recordCheck(id: string, check: ProviderKeyCheckRecord): Promise<AccountProviderKey | null> {
  const rows = await db
    .update(accountProviderKeys)
    .set(checkColumns(check))
    .where(and(eq(accountProviderKeys.id, id), isNull(accountProviderKeys.deletedAt)))
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
 * A key row by id in one read: its account and upstream whatever its state, and its sealed text only while the row and
 * its account are live, so a run on a key that is gone can still say which upstream's key it was.
 * @param id - The `account_provider_keys` row a task or turn recorded.
 * @returns The row, its sealed text null once it was replaced, deleted or erased or its account is gone; null when no
 *   row has the id.
 */
export async function keyRowById(id: string): Promise<{ id: string; userId: string; upstream: string; ciphertext: string | null } | null> {
  const rows = await db
    .select({
      id: accountProviderKeys.id,
      userId: accountProviderKeys.userId,
      upstream: accountProviderKeys.upstream,
      ciphertext: sql<string | null>`CASE WHEN ${accountProviderKeys.deletedAt} IS NULL AND ${users.deletedAt} IS NULL THEN ${accountProviderKeys.ciphertext} END`,
    })
    .from(accountProviderKeys)
    .innerJoin(users, eq(users.id, accountProviderKeys.userId))
    .where(eq(accountProviderKeys.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The live sealed key an account holds for an upstream, in one read.
 * @param userId - The account.
 * @param upstream - The upstream.
 * @returns The sealed key, or null when the account holds none there or is gone.
 */
export async function sealedLiveKeyFor(userId: string, upstream: string): Promise<SealedProviderKey | null> {
  const rows = await db
    .select({ id: accountProviderKeys.id, userId: accountProviderKeys.userId, upstream: accountProviderKeys.upstream, ciphertext: accountProviderKeys.ciphertext })
    .from(accountProviderKeys)
    .innerJoin(users, and(eq(users.id, accountProviderKeys.userId), isNull(users.deletedAt)))
    .where(and(eq(accountProviderKeys.userId, userId), eq(accountProviderKeys.upstream, upstream), isNull(accountProviderKeys.deletedAt)))
    .limit(1);
  const row = rows[0];
  return row === undefined || row.ciphertext === null ? null : { ...row, ciphertext: row.ciphertext };
}

/**
 * Which account and upstream a key row belongs to, whatever its state, never with its sealed text: a task that recorded
 * a row since replaced or deleted still names the upstream whose key is gone.
 * @param id - The `account_provider_keys` row a task or turn recorded.
 * @returns The row's account and upstream, or null when no row has the id.
 */
export async function keyOwnerById(id: string): Promise<{ id: string; userId: string; upstream: string } | null> {
  const rows = await db
    .select({ id: accountProviderKeys.id, userId: accountProviderKeys.userId, upstream: accountProviderKeys.upstream })
    .from(accountProviderKeys)
    .where(eq(accountProviderKeys.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Delete an account's key for an upstream: clear its sealed text and soft-delete the row, and drop the account's
 * model choices that named that upstream, in one transaction.
 * @param userId - The account.
 * @param upstream - The upstream.
 * @returns True when a live key was deleted.
 * @throws {Error} When no live account has the id.
 */
export async function deleteKey(userId: string, upstream: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockAccountRow(userId, tx);
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
    UPDATE account_provider_keys SET ciphertext = NULL, deleted_at = now(), updated_at = now()
    WHERE user_id = ANY(${[...userIds]}::uuid[]) AND deleted_at IS NULL`;
}
