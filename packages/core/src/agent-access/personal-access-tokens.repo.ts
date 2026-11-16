// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The `personal_access_tokens` table (#1488). Only a token's SHA-256 and its
 * first 8 characters are stored; the plaintext exists only in the answer to
 * its creation. A token is active while it is neither deleted nor expired at
 * the caller's `now`.
 */

import { and, count, eq, gt, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { PersonalAccessTokenEntity } from "@breatic/shared";
import { db } from "@core/db/client.js";
import { personalAccessTokens } from "@core/db/schema.js";

const entityColumns = {
  id: personalAccessTokens.id,
  userId: personalAccessTokens.userId,
  name: personalAccessTokens.name,
  tokenPrefix: personalAccessTokens.tokenPrefix,
  expiresAt: personalAccessTokens.expiresAt,
  lastUsedAt: personalAccessTokens.lastUsedAt,
  createdAt: personalAccessTokens.createdAt,
  deletedAt: personalAccessTokens.deletedAt,
};

/**
 * The condition "not deleted and not expired at `now`".
 * @param now - The caller's clock.
 * @returns The condition.
 */
function activeAt(now: Date): SQL | undefined {
  return and(
    isNull(personalAccessTokens.deletedAt),
    or(isNull(personalAccessTokens.expiresAt), gt(personalAccessTokens.expiresAt, now)),
  );
}

/**
 * Counts a user's active tokens. Callers enforcing the cap hold the user's
 * row lock, which is what makes the count hold until they insert.
 * @param userId - The user.
 * @param now - The caller's clock.
 * @returns How many are active.
 * @throws {Error} When the database read fails.
 */
export async function countActive(userId: string, now: Date): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(personalAccessTokens)
    .where(and(eq(personalAccessTokens.userId, userId), activeAt(now)));
  return row?.n ?? 0;
}

/**
 * Inserts a token.
 * @param input - Its owner, name, SHA-256 hex, first 8 characters and expiry.
 * @param input.userId - The owner.
 * @param input.name - The token's name.
 * @param input.tokenHash - SHA-256 hex of the plaintext.
 * @param input.tokenPrefix - The plaintext's first 8 characters.
 * @param input.expiresAt - When it expires; null never.
 * @returns The stored token.
 * @throws {Error} When the database write fails.
 */
export async function insert(input: {
  userId: string;
  name: string;
  tokenHash: string;
  tokenPrefix: string;
  expiresAt: Date | null;
}): Promise<PersonalAccessTokenEntity> {
  const [row] = await db.insert(personalAccessTokens).values(input).returning(entityColumns);
  if (!row) throw new Error("personal access token insert returned no row");
  return row;
}

/**
 * Finds an active token by the SHA-256 of its plaintext.
 * @param tokenHash - The SHA-256 hex.
 * @param now - The caller's clock.
 * @returns The token, or undefined when none is active.
 * @throws {Error} When the database read fails.
 */
export async function findActiveByHash(tokenHash: string, now: Date): Promise<PersonalAccessTokenEntity | undefined> {
  const [row] = await db
    .select(entityColumns)
    .from(personalAccessTokens)
    .where(and(eq(personalAccessTokens.tokenHash, tokenHash), activeAt(now)))
    .limit(1);
  return row;
}

/**
 * Whether a token is active.
 * @param id - The token id.
 * @param now - The caller's clock.
 * @returns True while it is neither deleted nor expired.
 * @throws {Error} When the database read fails.
 */
export async function isActive(id: string, now: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: personalAccessTokens.id })
    .from(personalAccessTokens)
    .where(and(eq(personalAccessTokens.id, id), activeAt(now)))
    .limit(1);
  return row !== undefined;
}

/**
 * Reads tokens by id, deleted ones included.
 * @param ids - The token ids.
 * @returns The tokens found.
 * @throws {Error} When the database read fails.
 */
export async function findByIds(ids: readonly string[]): Promise<PersonalAccessTokenEntity[]> {
  if (ids.length === 0) return [];
  return db.select(entityColumns).from(personalAccessTokens).where(inArray(personalAccessTokens.id, [...ids]));
}

/**
 * Records when a token was last used.
 * @param id - The token id.
 * @param at - When.
 * @throws {Error} When the database write fails.
 */
export async function touch(id: string, at: Date): Promise<void> {
  await db.update(personalAccessTokens).set({ lastUsedAt: at }).where(eq(personalAccessTokens.id, id));
}

/**
 * Soft-deletes a token.
 * @param id - The token id.
 * @throws {Error} When the database write fails.
 */
export async function softDelete(id: string): Promise<void> {
  await db
    .update(personalAccessTokens)
    .set({ deletedAt: sql`now()` })
    .where(and(eq(personalAccessTokens.id, id), isNull(personalAccessTokens.deletedAt)));
}
