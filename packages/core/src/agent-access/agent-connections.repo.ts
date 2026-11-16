// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The `agent_connections` table (#1488): one row per connected external agent
 * a user sees. An OAuth client has one live row per user (partial unique index
 * `agent_connections_live_client_key`); each personal access token has its own
 * row whose `client_key` is the token id. Rows are soft-deleted on disconnect.
 */

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AgentConnectionEntity, AgentConnectionKind } from "@breatic/shared";
import { db } from "@core/db/client.js";
import { agentConnections } from "@core/db/schema.js";

const entityColumns = {
  id: agentConnections.id,
  userId: agentConnections.userId,
  kind: agentConnections.kind,
  clientKey: agentConnections.clientKey,
  displayName: agentConnections.displayName,
  lastUsedAt: agentConnections.lastUsedAt,
  createdAt: agentConnections.createdAt,
  deletedAt: agentConnections.deletedAt,
};

const OAUTH_KINDS: AgentConnectionKind[] = ["cimd", "dcr"];

/**
 * Inserts a row; an OAuth row that already has a live twin for the same user
 * and client is skipped by the partial unique index rather than failing.
 * @param input - Owner, kind, client key and name.
 * @param input.userId - The user.
 * @param input.kind - How the agent connects.
 * @param input.clientKey - The OAuth client id, or the token id for `pat`.
 * @param input.displayName - The name the user sees.
 * @returns The new row, or undefined when a live OAuth row already held the slot.
 * @throws {Error} When the database write fails.
 */
export async function insert(input: {
  userId: string;
  kind: AgentConnectionKind;
  clientKey: string;
  displayName: string;
}): Promise<AgentConnectionEntity | undefined> {
  const [row] = await db
    .insert(agentConnections)
    .values(input)
    .onConflictDoNothing({
      target: [agentConnections.userId, agentConnections.clientKey],
      where: sql`${agentConnections.deletedAt} IS NULL AND ${agentConnections.kind} IN ('cimd', 'dcr')`,
    })
    .returning(entityColumns);
  return row;
}

/**
 * The live OAuth row of one user and client.
 * @param userId - The user.
 * @param clientKey - The OAuth client id.
 * @param lock - Take the row lock for the rest of the open transaction.
 * @returns The row, or undefined.
 * @throws {Error} When the database read fails.
 */
export async function findLiveOAuth(userId: string, clientKey: string, lock = false): Promise<AgentConnectionEntity | undefined> {
  const query = db
    .select(entityColumns)
    .from(agentConnections)
    .where(and(
      eq(agentConnections.userId, userId),
      eq(agentConnections.clientKey, clientKey),
      inArray(agentConnections.kind, OAUTH_KINDS),
      isNull(agentConnections.deletedAt),
    ));
  const [row] = await (lock ? query.for("update") : query).limit(1);
  return row;
}

/**
 * The live row of a personal access token.
 * @param tokenId - The token id.
 * @returns The row, or undefined once disconnected.
 * @throws {Error} When the database read fails.
 */
export async function findLivePat(tokenId: string): Promise<AgentConnectionEntity | undefined> {
  const [row] = await db
    .select(entityColumns)
    .from(agentConnections)
    .where(and(eq(agentConnections.kind, "pat"), eq(agentConnections.clientKey, tokenId), isNull(agentConnections.deletedAt)))
    .limit(1);
  return row;
}

/**
 * A live row by id, optionally only the given user's.
 * @param id - The row id.
 * @param userId - When given, the row must be this user's.
 * @param lock - Take the row lock for the rest of the open transaction.
 * @returns The row, or undefined.
 * @throws {Error} When the database read fails.
 */
export async function findLive(id: string, userId?: string, lock = false): Promise<AgentConnectionEntity | undefined> {
  const query = db
    .select(entityColumns)
    .from(agentConnections)
    .where(and(
      eq(agentConnections.id, id),
      userId === undefined ? undefined : eq(agentConnections.userId, userId),
      isNull(agentConnections.deletedAt),
    ));
  const [row] = await (lock ? query.for("update") : query).limit(1);
  return row;
}

/**
 * A user's live rows, newest first.
 * @param userId - The user.
 * @returns The rows.
 * @throws {Error} When the database read fails.
 */
export async function listLive(userId: string): Promise<AgentConnectionEntity[]> {
  return db
    .select(entityColumns)
    .from(agentConnections)
    .where(and(eq(agentConnections.userId, userId), isNull(agentConnections.deletedAt)))
    .orderBy(desc(agentConnections.createdAt), desc(agentConnections.id));
}

/**
 * Renames one of a user's live rows.
 * @param id - The row id.
 * @param userId - The user who must own it.
 * @param name - The new name.
 * @returns True when a row was renamed.
 * @throws {Error} When the database write fails.
 */
export async function rename(id: string, userId: string, name: string): Promise<boolean> {
  const rows = await db
    .update(agentConnections)
    .set({ displayName: name })
    .where(and(eq(agentConnections.id, id), eq(agentConnections.userId, userId), isNull(agentConnections.deletedAt)))
    .returning({ id: agentConnections.id });
  return rows.length > 0;
}

/**
 * Names of rows by id, deleted rows included.
 * @param ids - The row ids.
 * @returns One entry per row found.
 * @throws {Error} When the database read fails.
 */
export async function names(ids: readonly string[]): Promise<Array<{ id: string; name: string }>> {
  if (ids.length === 0) return [];
  return db
    .select({ id: agentConnections.id, name: agentConnections.displayName })
    .from(agentConnections)
    .where(inArray(agentConnections.id, [...ids]));
}

/**
 * Records when a row was last used.
 * @param id - The row id.
 * @param at - When.
 * @returns The row's kind and client key, or undefined when no such row exists.
 * @throws {Error} When the database write fails.
 */
export async function touch(id: string, at: Date): Promise<{ kind: AgentConnectionKind; clientKey: string } | undefined> {
  const [row] = await db
    .update(agentConnections)
    .set({ lastUsedAt: at })
    .where(eq(agentConnections.id, id))
    .returning({ kind: agentConnections.kind, clientKey: agentConnections.clientKey });
  return row;
}

/**
 * Soft-deletes a row.
 * @param id - The row id.
 * @throws {Error} When the database write fails.
 */
export async function softDelete(id: string): Promise<void> {
  await db
    .update(agentConnections)
    .set({ deletedAt: sql`now()` })
    .where(and(eq(agentConnections.id, id), isNull(agentConnections.deletedAt)));
}
