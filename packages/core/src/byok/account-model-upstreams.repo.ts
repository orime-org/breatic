// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Account model upstreams repository — data access for `account_model_upstreams` (inner#1953): the
 * upstream an account chose for a catalog model that is not a language model. One live choice per account and model;
 * a model without one runs on the deployment's keys.
 */

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { AccountModelUpstream } from "@breatic/shared";
import type { TransactionSql } from "postgres";
import { db, type DbTx } from "@core/db/client.js";
import { accountModelUpstreams, accountProviderKeys, users } from "@core/db/schema.js";

const entityColumns = {
  id: accountModelUpstreams.id,
  userId: accountModelUpstreams.userId,
  model: accountModelUpstreams.model,
  upstream: accountModelUpstreams.upstream,
  createdAt: accountModelUpstreams.createdAt,
  updatedAt: accountModelUpstreams.updatedAt,
};

/**
 * Serialise an account's key and model-choice writes: two replacements of one key cannot both retire the old row, and
 * a choice's check for a live key and a delete of that key cannot interleave.
 * @param tx - The open transaction.
 * @param userId - The account.
 * @returns Nothing once the lock is held.
 */
export async function lockAccount(tx: DbTx, userId: string): Promise<void> {
  await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("no key update");
}

/**
 * Set or clear the upstream an account chose for a model: the live choice is soft-deleted and, unless clearing, a
 * new one inserted, in one transaction. A choice naming an upstream the account holds no live key for is refused
 * under the account's lock, which a key's delete takes too, so a delete cannot slip between the check and the insert
 * and leave a choice that comes back with the next key. Whether the upstream can run the model is the caller's check.
 * @param userId - The account.
 * @param model - The catalog model.
 * @param upstream - The chosen upstream, or null to go back to the deployment's keys.
 * @returns False when the account holds no live key for the upstream, and nothing was written; true otherwise.
 * @throws {Error} When the account does not exist (foreign key).
 */
export async function setModelUpstream(userId: string, model: string, upstream: string | null): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockAccount(tx, userId);
    if (upstream !== null) {
      const [held] = await tx
        .select({ id: accountProviderKeys.id })
        .from(accountProviderKeys)
        .where(and(eq(accountProviderKeys.userId, userId), eq(accountProviderKeys.upstream, upstream), isNull(accountProviderKeys.deletedAt)))
        .limit(1);
      if (held === undefined) return false;
    }
    await tx
      .update(accountModelUpstreams)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(accountModelUpstreams.userId, userId), eq(accountModelUpstreams.model, model), isNull(accountModelUpstreams.deletedAt)));
    if (upstream !== null) await tx.insert(accountModelUpstreams).values({ userId, model, upstream });
    return true;
  });
}

/**
 * The upstream an account chose for a model.
 * @param userId - The account.
 * @param model - The catalog model.
 * @returns The upstream, or null when the model runs on the deployment's keys.
 */
export async function modelUpstreamFor(userId: string, model: string): Promise<string | null> {
  const rows = await db
    .select({ upstream: accountModelUpstreams.upstream })
    .from(accountModelUpstreams)
    .where(and(eq(accountModelUpstreams.userId, userId), eq(accountModelUpstreams.model, model), isNull(accountModelUpstreams.deletedAt)))
    .limit(1);
  return rows[0]?.upstream ?? null;
}

/**
 * Every live choice of an account.
 * @param userId - The account.
 * @returns The choices, by model.
 */
export async function liveModelUpstreamsFor(userId: string): Promise<AccountModelUpstream[]> {
  return db
    .select(entityColumns)
    .from(accountModelUpstreams)
    .where(and(eq(accountModelUpstreams.userId, userId), isNull(accountModelUpstreams.deletedAt)))
    .orderBy(asc(accountModelUpstreams.model));
}

/**
 * Drop an account's choices that name an upstream, inside the transaction that deletes that upstream's key.
 * @param userId - The account.
 * @param upstream - The upstream whose key is going.
 * @param tx - The key deletion's transaction.
 * @returns Nothing.
 */
export async function dropChoicesForUpstream(userId: string, upstream: string, tx: DbTx): Promise<void> {
  await tx
    .update(accountModelUpstreams)
    .set({ deletedAt: sql`now()` })
    .where(and(eq(accountModelUpstreams.userId, userId), eq(accountModelUpstreams.upstream, upstream), isNull(accountModelUpstreams.deletedAt)));
}

/**
 * Erase deleted accounts' model choices inside the account erase's own transaction: every live choice soft-deleted.
 * @param userIds - The accounts.
 * @param tx - The erase's transaction.
 * @returns Nothing.
 */
export async function eraseForAccounts(userIds: readonly string[], tx: TransactionSql): Promise<void> {
  await tx`
    UPDATE account_model_upstreams SET deleted_at = now(), updated_at = now()
    WHERE user_id = ANY(${[...userIds]}::uuid[]) AND deleted_at IS NULL`;
}
