// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Migration 0115 (#1363): every block of memory written before entries
 * existed becomes one entry, word for word. A project block becomes a
 * project-scope entry; a conversation block becomes a conversation-scope
 * entry and its row is emptied, because from then on that row holds the
 * progress note. Empty and deleted blocks are left alone, and replaying the
 * migration adds nothing a first run already added. Each case replays the
 * migration inside a transaction that is rolled back.
 */

import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { readFile } from "node:fs/promises";
import postgres from "postgres";

const MIGRATION = new URL(
  "../../../../core/src/db/migrations/0115_migrate_block_memories.sql",
  import.meta.url,
);

let sql: ReturnType<typeof postgres>;
let statements: string[];

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "agent-memories-migration-test" },
  });
  statements = (await readFile(MIGRATION, "utf8")).split("--> statement-breakpoint");
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

class Rollback extends Error {}

/**
 * Run `body` in a transaction that is always rolled back.
 * @param body - Seeds, replays the migration and reads what it left.
 * @returns What `body` returned.
 */
async function rolledBack<T>(body: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await sql
    .begin(async (tx) => {
      result = await body(tx);
      throw new Rollback();
    })
    .catch((err: unknown) => {
      if (!(err instanceof Rollback)) throw err;
    });
  return result as T;
}

/**
 * Replay every statement of the migration.
 * @param tx - The transaction to run them in.
 */
async function migrate(tx: postgres.TransactionSql): Promise<void> {
  for (const statement of statements) await tx.unsafe(statement);
}

let seq = 0;

/** What one seeded owner has. */
interface Owner {
  userId: string;
  projectId: string;
  conversationId: string;
}

/**
 * Seed an owner with a project and a conversation in it.
 * @param tx - The transaction to seed inside.
 * @returns The ids.
 */
async function seedOwner(tx: postgres.TransactionSql): Promise<Owner> {
  const tag = `amm-${seq++}-${Date.now().toString(36)}`;
  const [user] = await tx<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`${tag}@example.com`}, true) RETURNING id
  `;
  const [studio] = await tx<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`${tag}-studio`}, 'personal', ${tag}) RETURNING id
  `;
  const [project] = await tx<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studio!.id}, ${user!.id}, ${tag}, ${`${tag}-p`}) RETURNING id
  `;
  const [conversation] = await tx<{ id: string }[]>`
    INSERT INTO conversations (user_id, project_id) VALUES (${user!.id}, ${project!.id}) RETURNING id
  `;
  return { userId: user!.id, projectId: project!.id, conversationId: conversation!.id };
}

/** One row of `agent_memories`, as the assertions read it. */
interface EntryRow {
  user_id: string;
  project_id: string | null;
  conversation_id: string | null;
  source_conversation_id: string | null;
  title: string;
  content: string;
  origin: string;
  deleted_at: Date | null;
}

/**
 * The entries an owner has.
 * @param tx - The transaction to read inside.
 * @param userId - Whose entries.
 * @returns Every entry, in no particular order.
 */
async function entriesOf(tx: postgres.TransactionSql, userId: string): Promise<EntryRow[]> {
  return await tx<EntryRow[]>`
    SELECT user_id, project_id, conversation_id, source_conversation_id, title, content, origin, deleted_at
    FROM agent_memories WHERE user_id = ${userId}
  `;
}

// Longer than an entry may be written today, with characters outside the
// basic plane, so a cut or a re-encoding anywhere shows up as a difference.
const LONG_BLOCK = `Lead: Lin Wu 🧥, tear mole under the left eye.\n${"港风胶片，90 年代。".repeat(600)}`;

describe("migration 0115 — block memories become entries", () => {
  it("turns a project block into one project entry, word for word", async () => {
    const result = await rolledBack(async (tx) => {
      const owner = await seedOwner(tx);
      await tx`
        INSERT INTO project_memories (user_id, project_id, content) VALUES (${owner.userId}, ${owner.projectId}, ${LONG_BLOCK})
      `;
      await migrate(tx);
      return { owner, entries: await entriesOf(tx, owner.userId) };
    });

    expect(result.entries).toEqual([
      {
        user_id: result.owner.userId,
        project_id: result.owner.projectId,
        conversation_id: null,
        source_conversation_id: null,
        title: "Earlier project memory",
        content: LONG_BLOCK,
        origin: "migration",
        deleted_at: null,
      },
    ]);
  });

  it("turns a conversation block into one conversation entry and empties the row", async () => {
    const result = await rolledBack(async (tx) => {
      const owner = await seedOwner(tx);
      await tx`
        INSERT INTO conversation_memories (conversation_id, content) VALUES (${owner.conversationId}, ${LONG_BLOCK})
      `;
      await migrate(tx);
      const [row] = await tx<{ content: string }[]>`
        SELECT content FROM conversation_memories WHERE conversation_id = ${owner.conversationId}
      `;
      return { owner, entries: await entriesOf(tx, owner.userId), left: row!.content };
    });

    expect(result.entries).toEqual([
      {
        user_id: result.owner.userId,
        project_id: result.owner.projectId,
        conversation_id: result.owner.conversationId,
        source_conversation_id: result.owner.conversationId,
        title: "Earlier conversation memory",
        content: LONG_BLOCK,
        origin: "migration",
        deleted_at: null,
      },
    ]);
    expect(result.left).toBe("");
  });

  it("leaves empty blocks, deleted blocks and blocks of deleted conversations alone", async () => {
    const result = await rolledBack(async (tx) => {
      const owner = await seedOwner(tx);
      const second = await tx<{ id: string }[]>`
        INSERT INTO conversations (user_id, project_id, deleted_at)
        VALUES (${owner.userId}, ${owner.projectId}, now()) RETURNING id
      `;
      await tx`
        INSERT INTO project_memories (user_id, project_id, content) VALUES (${owner.userId}, ${owner.projectId}, '')
      `;
      await tx`
        INSERT INTO conversation_memories (conversation_id, content, deleted_at)
        VALUES (${owner.conversationId}, 'deleted block', now())
      `;
      await tx`
        INSERT INTO conversation_memories (conversation_id, content) VALUES (${second[0]!.id}, 'in a deleted conversation')
      `;
      await migrate(tx);
      return entriesOf(tx, owner.userId);
    });

    expect(result).toEqual([]);
  });

  it("adds nothing when it runs a second time", async () => {
    const result = await rolledBack(async (tx) => {
      const owner = await seedOwner(tx);
      await tx`
        INSERT INTO project_memories (user_id, project_id, content) VALUES (${owner.userId}, ${owner.projectId}, 'the project so far')
      `;
      await tx`
        INSERT INTO conversation_memories (conversation_id, content) VALUES (${owner.conversationId}, 'what was settled')
      `;
      await migrate(tx);
      await migrate(tx);
      return entriesOf(tx, owner.userId);
    });

    expect(result.map((e) => e.content).sort()).toEqual(["the project so far", "what was settled"]);
  });
});
