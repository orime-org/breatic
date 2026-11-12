// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db, documentVersions as v, studios, decodeActivityCursor, encodeActivityCursor } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import type { DocumentVersion } from "@breatic/shared";

/**
 * Render a timestamp as UTC ISO text at the precision the column stores.
 * @param column - The timestamp column.
 * @returns The SQL expression.
 */
function iso(column: PgColumn): SQL<string> {
  return sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

const columns = {
  id: v.id,
  projectId: v.projectId,
  spaceId: v.spaceId,
  name: v.name,
  schemaVersion: v.schemaVersion,
  createdAt: iso(v.createdAt),
  updatedAt: iso(v.updatedAt),
  createdById: v.createdByUserId,
  createdByName: studios.name,
};

type Row = { [K in keyof typeof columns]: K extends "name" | "createdByName" ? string | null : string };

/**
 * Map a selected row to the entity.
 * @param row - The row.
 * @returns The entity.
 */
function toEntity(row: Row): DocumentVersion {
  return {
    id: row.id,
    projectId: row.projectId,
    spaceId: row.spaceId,
    name: row.name,
    schemaVersion: row.schemaVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: { id: row.createdById, name: row.createdByName },
  };
}

/** A snapshot's identity: its id and the document it must belong to. */
export interface VersionKey {
  id: string;
  projectId: string;
  spaceId: string;
}

/**
 * The live row with this id in this document.
 * @param key - The snapshot and its document.
 * @returns The condition.
 */
function liveIn(key: VersionKey): SQL | undefined {
  return and(eq(v.id, key.id), eq(v.projectId, key.projectId), eq(v.spaceId, key.spaceId), isNull(v.deletedAt));
}

/** The saver's display name lives on their personal studio. */
const saverStudio = and(eq(studios.createdByUserId, v.createdByUserId), eq(studios.type, "personal"), isNull(studios.deletedAt));

/**
 * Serialises saves into one document until the transaction ends.
 * @param projectId - The project.
 * @param spaceId - The document Space.
 * @param tx - The save's transaction.
 */
export async function lockSpace(projectId: string, spaceId: string, tx: DbTx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`document-versions:${projectId}:${spaceId}`}))`);
}

/**
 * How many live snapshots a document holds.
 * @param projectId - The project.
 * @param spaceId - The document Space.
 * @param tx - The caller's transaction.
 * @returns The count.
 */
export async function countLive(projectId: string, spaceId: string, tx: DbTx): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(v)
    .where(and(eq(v.projectId, projectId), eq(v.spaceId, spaceId), isNull(v.deletedAt)));
  return row?.n ?? 0;
}

/**
 * Insert one snapshot.
 * @param input - What to keep.
 * @param input.projectId - The project.
 * @param input.spaceId - The document Space.
 * @param input.userId - Who saved it.
 * @param input.name - Its name, if any.
 * @param input.content - The body's ProseMirror JSON.
 * @param input.schemaVersion - The document schema it was written in.
 * @param input.contentBytes - The JSON's size in bytes.
 * @param tx - The save's transaction.
 * @returns The new snapshot.
 */
export async function insert(
  input: { projectId: string; spaceId: string; userId: string; name: string | null; content: Record<string, unknown>; schemaVersion: string; contentBytes: number },
  tx: DbTx,
): Promise<DocumentVersion> {
  const [created] = await tx
    .insert(v)
    .values({
      projectId: input.projectId,
      spaceId: input.spaceId,
      createdByUserId: input.userId,
      name: input.name,
      content: input.content,
      schemaVersion: input.schemaVersion,
      contentBytes: input.contentBytes,
    })
    .returning({ id: v.id });
  const [row] = await tx.select(columns).from(v).leftJoin(studios, saverStudio).where(eq(v.id, created!.id));
  return toEntity(row as Row);
}

/**
 * One page of a document's snapshots, newest first.
 * @param projectId - The project.
 * @param spaceId - The document Space.
 * @param cursor - Where the previous page ended, or undefined for the first.
 * @param limit - The page size.
 * @returns The page and where the next one starts, or null at the end.
 */
export async function listPage(
  projectId: string,
  spaceId: string,
  cursor: string | undefined,
  limit: number,
): Promise<{ versions: DocumentVersion[]; nextCursor: string | null }> {
  const after = cursor === undefined ? null : decodeActivityCursor(cursor);
  // The cursor carries `created_at::text`, the form the activity cursor reads,
  // so a row's microseconds survive the round trip.
  const rows = (await db
    .select({ ...columns, cursorAt: sql<string>`${v.createdAt}::text` })
    .from(v)
    .leftJoin(studios, saverStudio)
    .where(and(
      eq(v.projectId, projectId),
      eq(v.spaceId, spaceId),
      isNull(v.deletedAt),
      after === null ? undefined : sql`(${v.createdAt}, ${v.id}) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`,
    ))
    .orderBy(desc(v.createdAt), desc(v.id))
    .limit(limit + 1)) as Array<Row & { cursorAt: string }>;
  const kept = rows.slice(0, limit);
  const last = kept[kept.length - 1];
  return {
    versions: kept.map(({ cursorAt: _cursorAt, ...row }) => toEntity(row)),
    nextCursor: rows.length > limit && last ? encodeActivityCursor(last.cursorAt, last.id) : null,
  };
}

/**
 * One live snapshot with its body.
 * @param key - The snapshot and its document.
 * @returns It, or null when it is not a live snapshot of that document.
 */
export async function findWithContent(key: VersionKey): Promise<{ version: DocumentVersion; content: Record<string, unknown> } | null> {
  const [row] = await db
    .select({ ...columns, content: v.content })
    .from(v)
    .leftJoin(studios, saverStudio)
    .where(liveIn(key));
  if (!row) return null;
  const { content, ...rest } = row;
  return { version: toEntity(rest), content };
}

/**
 * Rename a live snapshot.
 * @param key - The snapshot and its document.
 * @param name - The new name, or null to clear it.
 * @returns Whether a live snapshot was renamed.
 */
export async function rename(key: VersionKey, name: string | null): Promise<boolean> {
  const rows = await db.update(v).set({ name, updatedAt: sql`now()` }).where(liveIn(key)).returning({ id: v.id });
  return rows.length > 0;
}

/**
 * Soft-delete a live snapshot.
 * @param key - The snapshot and its document.
 * @param userId - Who deleted it.
 * @returns Whether a live snapshot was deleted.
 */
export async function softDelete(key: VersionKey, userId: string): Promise<boolean> {
  const rows = await db
    .update(v)
    .set({ deletedAt: sql`now()`, deletedByUserId: userId, updatedAt: sql`now()` })
    .where(liveIn(key))
    .returning({ id: v.id });
  return rows.length > 0;
}
