// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Memory repository — the Agent's memory entries and each conversation's
 * progress note (#1363).
 *
 * An entry is the member's own. One turn sees two sets of them: the
 * member's entries of the Project (no conversation) and the entries of the
 * conversation it runs in. Every read and write here is keyed by the member
 * as well as the Project or conversation; the compiler sees neither, so a
 * `where` one `eq` short reads a neighbour's memory without complaint.
 */

import { and, count, desc, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { db } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { agentMemories, conversationMemories } from "@breatic/core";
import type { AgentMemoryEntity } from "@breatic/shared";

/** Whose entries a turn sees, and where. */
export interface MemoryScopeKey {
  userId: string;
  projectId: string;
  conversationId: string;
}

/** The index a turn's system prompt lists. */
export interface MemoryIndex {
  /** Newest first, migrated blocks left out. */
  entries: Array<{ id: string; title: string }>;
  /** Migrated blocks, newest first, in full. */
  migrated: Array<{ id: string; title: string; content: string }>;
  /** How many entries the bound left out. */
  olderCount: number;
}

type Row = typeof agentMemories.$inferSelect;

/**
 * One row as the rest of the server reads it.
 * @param row - The row.
 * @returns The entity.
 * @throws {never} Never.
 */
function toEntity(row: Row): AgentMemoryEntity {
  return {
    id: row.id,
    userId: row.userId,
    projectId: row.projectId,
    conversationId: row.conversationId,
    sourceConversationId: row.sourceConversationId,
    title: row.title,
    content: row.content,
    origin: row.origin as AgentMemoryEntity["origin"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

/**
 * The live entries one turn sees: the member's in the Project, and the ones
 * of this conversation.
 * @param scope - Whose and where.
 * @returns The condition.
 * @throws {never} Never.
 */
function visible(scope: MemoryScopeKey): SQL | undefined {
  return and(
    eq(agentMemories.userId, scope.userId),
    isNull(agentMemories.deletedAt),
    or(
      and(isNull(agentMemories.conversationId), eq(agentMemories.projectId, scope.projectId)),
      eq(agentMemories.conversationId, scope.conversationId),
    ),
  );
}

// ── Progress note ────────────────────────────────────────────────────

/**
 * A conversation's progress note.
 * @param conversationId - The conversation.
 * @returns The note, or an empty string when there is none.
 */
export async function getProgress(conversationId: string): Promise<string> {
  const rows = await db
    .select({ content: conversationMemories.content })
    .from(conversationMemories)
    .where(and(eq(conversationMemories.conversationId, conversationId), isNull(conversationMemories.deletedAt)))
    .limit(1);
  return rows[0]?.content ?? "";
}

/**
 * Write a conversation's progress note.
 * @param conversationId - The conversation.
 * @param content - The note, replacing the one there.
 * @param tx - The transaction to run inside, when the caller has one.
 */
export async function upsertProgress(conversationId: string, content: string, tx?: DbTx): Promise<void> {
  await (tx ?? db)
    .insert(conversationMemories)
    .values({ conversationId, content })
    .onConflictDoUpdate({
      target: conversationMemories.conversationId,
      set: { content, updatedAt: new Date() },
    });
}

// ── Entries ──────────────────────────────────────────────────────────

/**
 * The index one turn's system prompt lists.
 * @param scope - Whose and where.
 * @param limit - How many entries it lists at most.
 * @returns The index.
 */
export async function listIndex(scope: MemoryScopeKey, limit: number): Promise<MemoryIndex> {
  const notMigrated = and(visible(scope), ne(agentMemories.origin, "migration"));
  const [migrated, entries, total] = await Promise.all([
    db
      .select({ id: agentMemories.id, title: agentMemories.title, content: agentMemories.content })
      .from(agentMemories)
      .where(and(visible(scope), eq(agentMemories.origin, "migration")))
      .orderBy(desc(agentMemories.updatedAt), desc(agentMemories.id)),
    db
      .select({ id: agentMemories.id, title: agentMemories.title })
      .from(agentMemories)
      .where(notMigrated)
      .orderBy(desc(agentMemories.updatedAt), desc(agentMemories.id))
      .limit(limit),
    db.select({ n: count() }).from(agentMemories).where(notMigrated),
  ]);
  return { entries, migrated, olderCount: Math.max(0, (total[0]?.n ?? 0) - entries.length) };
}

/**
 * Every live entry one turn sees, migrated blocks first, then newest first.
 * @param scope - Whose and where.
 * @returns The entries.
 */
export async function listVisible(scope: MemoryScopeKey): Promise<AgentMemoryEntity[]> {
  const rows = await db
    .select()
    .from(agentMemories)
    .where(visible(scope))
    .orderBy(
      sql`CASE WHEN ${agentMemories.origin} = 'migration' THEN 0 ELSE 1 END`,
      desc(agentMemories.updatedAt),
      desc(agentMemories.id),
    );
  return rows.map(toEntity);
}

/**
 * One entry of the member's, deleted or not, wherever it belongs.
 * @param userId - Whose.
 * @param id - The entry.
 * @returns It, or null when the member has no entry by that id.
 */
export async function findOwnEntry(userId: string, id: string): Promise<AgentMemoryEntity | null> {
  const rows = await db
    .select()
    .from(agentMemories)
    .where(and(eq(agentMemories.id, id), eq(agentMemories.userId, userId)))
    .limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}

/**
 * The live entries named that one turn sees.
 * @param scope - Whose and where.
 * @param ids - The entries.
 * @returns Them, in no particular order.
 */
export async function getVisible(scope: MemoryScopeKey, ids: readonly string[]): Promise<AgentMemoryEntity[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(agentMemories)
    .where(and(visible(scope), inArray(agentMemories.id, [...ids])));
  return rows.map(toEntity);
}

/**
 * Live entries one turn sees whose title or content holds the words as
 * written, ignoring case, newest first.
 * @param scope - Whose and where.
 * @param query - The words.
 * @param page - Where the page starts and how long it is.
 * @param page.offset - How many matches come before it.
 * @param page.limit - How many it holds at most.
 * @returns The page, and whether more follow.
 */
export async function searchVisible(
  scope: MemoryScopeKey,
  query: string,
  page: { offset: number; limit: number },
): Promise<{ items: AgentMemoryEntity[]; more: boolean }> {
  // `%`, `_` and the escape itself are literal characters here, not patterns.
  const pattern = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await db
    .select()
    .from(agentMemories)
    .where(
      and(
        visible(scope),
        or(
          sql`${agentMemories.title} ILIKE ${pattern} ESCAPE '\\'`,
          sql`${agentMemories.content} ILIKE ${pattern} ESCAPE '\\'`,
        ),
      ),
    )
    .orderBy(desc(agentMemories.updatedAt), desc(agentMemories.id))
    .offset(page.offset)
    .limit(page.limit + 1);
  return { items: rows.slice(0, page.limit).map(toEntity), more: rows.length > page.limit };
}

/** What a new entry is written with. */
export interface NewEntry {
  userId: string;
  projectId: string;
  /** Set for an entry of this conversation alone. */
  conversationId: string | null;
  sourceConversationId: string;
  title: string;
  content: string;
  origin: "agent" | "consolidation";
}

/**
 * Add an entry.
 * @param entry - What it holds.
 * @param tx - The transaction to run inside, when the caller has one.
 * @returns The entry.
 * @throws {Error} When the row is refused, which leaves nothing written.
 */
export async function insertEntry(entry: NewEntry, tx?: DbTx): Promise<AgentMemoryEntity> {
  const [row] = await (tx ?? db).insert(agentMemories).values(entry).returning();
  if (!row) throw new Error("agent_memories insert returned no row");
  return toEntity(row);
}

/** An entry's title and content, as a writer read them. */
export interface EntryText {
  title: string;
  content: string;
}

/**
 * The condition that picks the live entry by id, and, when given, only while
 * it still holds what the writer read.
 * @param id - The entry.
 * @param unchanged - What it held when read; absent, any content matches.
 * @returns The condition.
 * @throws {never} Never.
 */
function liveEntry(id: string, unchanged?: EntryText): SQL | undefined {
  return and(
    eq(agentMemories.id, id),
    isNull(agentMemories.deletedAt),
    ...(unchanged === undefined ? [] : [eq(agentMemories.title, unchanged.title), eq(agentMemories.content, unchanged.content)]),
  );
}

/**
 * Replace a live entry's title and content, and where it is read when given.
 * @param id - The entry.
 * @param change - What it now holds.
 * @param change.title - Its title.
 * @param change.content - Its content.
 * @param change.conversationId - Set to move it to that conversation alone, null to the Project; absent, it stays.
 * @param tx - The transaction to run inside, when the caller has one.
 * @param unchanged - What the caller read; given, the write happens only while the entry still holds it.
 * @returns The entry, or null when there is no live entry by that id holding what the caller read.
 */
export async function updateEntry(
  id: string,
  change: { title: string; content: string; conversationId?: string | null },
  tx?: DbTx,
  unchanged?: EntryText,
): Promise<AgentMemoryEntity | null> {
  const [row] = await (tx ?? db)
    .update(agentMemories)
    .set({ ...change, updatedAt: new Date() })
    .where(liveEntry(id, unchanged))
    .returning();
  return row ? toEntity(row) : null;
}

/**
 * Delete a live entry, softly.
 * @param id - The entry.
 * @param tx - The transaction to run inside, when the caller has one.
 * @param unchanged - What the caller read; given, the delete happens only while the entry still holds it.
 * @returns The entry, or null when there is no live entry by that id holding what the caller read.
 */
export async function softDeleteEntry(id: string, tx?: DbTx, unchanged?: EntryText): Promise<AgentMemoryEntity | null> {
  const [row] = await (tx ?? db)
    .update(agentMemories)
    .set({ deletedAt: new Date() })
    .where(liveEntry(id, unchanged))
    .returning();
  return row ? toEntity(row) : null;
}

/**
 * Delete the entries of conversations that are being deleted; the Project's
 * stay.
 * @param tx - The deleting transaction.
 * @param conversationIds - The conversations.
 * @param now - The deletion time the cascade stamps.
 */
export async function softDeleteConversationEntries(
  tx: DbTx,
  conversationIds: readonly string[],
  now: Date,
): Promise<void> {
  if (conversationIds.length === 0) return;
  await tx
    .update(agentMemories)
    .set({ deletedAt: now })
    .where(and(inArray(agentMemories.conversationId, [...conversationIds]), isNull(agentMemories.deletedAt)));
}
