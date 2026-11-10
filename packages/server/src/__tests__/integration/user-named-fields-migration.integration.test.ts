// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Migration 0116 (#1378): stored fields named after the person using the
 * product move from `reader` to `user`. A tool failure's `readerKey` inside
 * `conversation_messages.parts` becomes `userKey`; `reader_locale` in
 * `tasks.params` and in `node_history.metadata.params` becomes `user_locale`.
 * Values, element order and every other key stay as they were, and the SQL
 * runs again with no further change, because the follow-up release replays
 * it in a migration file of its own. Each case replays the migration inside a
 * transaction that is rolled back.
 */

import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { readFile } from "node:fs/promises";
import postgres from "postgres";

const MIGRATION = new URL("../../../../core/src/db/migrations/0116_user_named_fields.sql", import.meta.url);

let sql: ReturnType<typeof postgres>;
let statements: string[];

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "user-named-fields-migration-test" },
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
  const tag = `unf-${seq++}-${Date.now().toString(36)}`;
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

/**
 * Store one assistant message with these parts.
 * @param tx - The transaction to seed inside.
 * @param owner - Whose conversation it goes in.
 * @param parts - The parts, in the shape the store keeps them.
 * @returns The row's id.
 */
async function storeMessage(tx: postgres.TransactionSql, owner: Owner, parts: unknown[]): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO conversation_messages (conversation_id, user_id, role, turn_index, seq, parts, updated_at)
    VALUES (${owner.conversationId}, ${owner.userId}, 'assistant', ${seq++}, 1,
            ${tx.json(parts)}, '2026-01-02T03:04:05Z')
    RETURNING id
  `;
  return row!.id;
}

/**
 * The parts and last update of one stored message.
 * @param tx - The transaction to read inside.
 * @param id - The row.
 * @returns What the row holds.
 */
async function messageOf(tx: postgres.TransactionSql, id: string): Promise<{ parts: unknown; updated_at: Date }> {
  const [row] = await tx<{ parts: unknown; updated_at: Date }[]>`
    SELECT parts, updated_at FROM conversation_messages WHERE id = ${id}
  `;
  return row!;
}

/**
 * Store one task with these params.
 * @param tx - The transaction to seed inside.
 * @param owner - Whose task it is.
 * @param params - The params, as the route wrote them.
 * @returns The row's id.
 */
async function storeTask(tx: postgres.TransactionSql, owner: Owner, params: Record<string, unknown>): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO tasks (user_id, space_id, task_type, mode, status, params)
    VALUES (${owner.userId}, ${crypto.randomUUID()}, 'understand', 'append', 'completed',
            ${tx.json(params)})
    RETURNING id
  `;
  return row!.id;
}

/**
 * Store one history row with this metadata.
 * @param tx - The transaction to seed inside.
 * @param owner - Whose project it is in.
 * @param metadata - The metadata, as the run wrote it.
 * @returns The row's id.
 */
async function storeHistory(
  tx: postgres.TransactionSql,
  owner: Owner,
  metadata: Record<string, unknown>,
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO node_history (project_id, node_id, user_id, entry_type, status, content, metadata)
    VALUES (${owner.projectId}, ${crypto.randomUUID()}, ${owner.userId}, 'generation', 'success',
            'a caption', ${tx.json(metadata)})
    RETURNING id
  `;
  return row!.id;
}

/**
 * A stored failed call with its line under the given name.
 * @param id - The call's id.
 * @param line - The fields that carry the line.
 * @returns The part.
 */
function failedCall(id: string, line: Record<string, string>): Record<string, unknown> {
  return {
    type: "tool",
    toolCallId: id,
    toolName: "web_search",
    input: { query: "readerKey" },
    status: "error",
    failure: { kind: "tool_failed", forModel: "the site answered 503", ...line },
  };
}

const TEXT = { type: "text", text: "Looking for the readerKey and reader_locale words is not enough." };
const SUCCESS = {
  type: "tool",
  toolCallId: "ok",
  toolName: "web_search",
  input: { query: "q" },
  status: "success",
  output: { readerKey: "kept: this is the tool's own output" },
};

describe("migration 0116 — stored fields named after the user", () => {
  it("renames readerKey to userKey on every failed call, keeping order and everything else", async () => {
    const result = await rolledBack(async (tx) => {
      const owner = await seedOwner(tx);
      const id = await storeMessage(tx, owner, [
        TEXT,
        failedCall("a", { readerKey: "chat.tool.failure.busy" }),
        SUCCESS,
        failedCall("b", { userKey: "chat.tool.failure.refused" }),
        {
          ...failedCall("c", { readerKey: "chat.tool.unfinished" }),
          failure: { kind: "user_aborted", forModel: "stopped", readerKey: "chat.tool.unfinished" },
        },
      ]);
      await migrate(tx);
      return messageOf(tx, id);
    });

    expect(result.parts).toEqual([
      TEXT,
      failedCall("a", { userKey: "chat.tool.failure.busy" }),
      SUCCESS,
      failedCall("b", { userKey: "chat.tool.failure.refused" }),
      {
        ...failedCall("c", { userKey: "chat.tool.unfinished" }),
        failure: { kind: "user_aborted", forModel: "stopped", userKey: "chat.tool.unfinished" },
      },
    ]);
    expect(result.updated_at.toISOString()).toBe("2026-01-02T03:04:05.000Z");
  });

  it("keeps userKey and drops readerKey when a failure carries both", async () => {
    const parts = await rolledBack(async (tx) => {
      const owner = await seedOwner(tx);
      const id = await storeMessage(tx, owner, [
        failedCall("a", { userKey: "chat.tool.failure.busy", readerKey: "chat.tool.failure.busy" }),
      ]);
      await migrate(tx);
      return (await messageOf(tx, id)).parts;
    });

    expect(parts).toEqual([failedCall("a", { userKey: "chat.tool.failure.busy" })]);
  });

  it("renames reader_locale to user_locale in a task's params", async () => {
    const rows = await rolledBack(async (tx) => {
      const owner = await seedOwner(tx);
      const old = await storeTask(tx, owner, { source_type: "image", reader_locale: "ja", prompt: "q" });
      const both = await storeTask(tx, owner, { source_type: "audio", user_locale: "zh-TW", reader_locale: "zh-TW" });
      const none = await storeTask(tx, owner, { source_type: "image", prompt: "reader_locale" });
      await migrate(tx);
      const read = async (id: string): Promise<unknown> =>
        (await tx<{ params: unknown }[]>`SELECT params FROM tasks WHERE id = ${id}`)[0]!.params;
      return { old: await read(old), both: await read(both), none: await read(none) };
    });

    expect(rows.old).toEqual({ source_type: "image", user_locale: "ja", prompt: "q" });
    expect(rows.both).toEqual({ source_type: "audio", user_locale: "zh-TW" });
    expect(rows.none).toEqual({ source_type: "image", prompt: "reader_locale" });
  });

  it("renames reader_locale to user_locale under a history row's params, leaving the rest of the metadata", async () => {
    const rows = await rolledBack(async (tx) => {
      const owner = await seedOwner(tx);
      const old = await storeHistory(tx, owner, {
        model: "google/gemini-3.8-flash",
        params: { source_type: "image", reader_locale: "en" },
        credits: 0.18,
      });
      const none = await storeHistory(tx, owner, { model: "m", params: { source_type: "image" } });
      await migrate(tx);
      const read = async (id: string): Promise<unknown> =>
        (await tx<{ metadata: unknown }[]>`SELECT metadata FROM node_history WHERE id = ${id}`)[0]!.metadata;
      return { old: await read(old), none: await read(none) };
    });

    expect(rows.old).toEqual({
      model: "google/gemini-3.8-flash",
      params: { source_type: "image", user_locale: "en" },
      credits: 0.18,
    });
    expect(rows.none).toEqual({ model: "m", params: { source_type: "image" } });
  });

  it("changes nothing when run a second time", async () => {
    const rows = await rolledBack(async (tx) => {
      const owner = await seedOwner(tx);
      const message = await storeMessage(tx, owner, [TEXT, failedCall("a", { readerKey: "chat.tool.failure.busy" })]);
      const task = await storeTask(tx, owner, { reader_locale: "ja" });
      const history = await storeHistory(tx, owner, { params: { reader_locale: "en" } });
      /**
       * Read back the three rows.
       * @returns Their stored values.
       */
      const read = async (): Promise<unknown[]> => [
        (await messageOf(tx, message)).parts,
        (await tx<{ params: unknown }[]>`SELECT params FROM tasks WHERE id = ${task}`)[0]!.params,
        (await tx<{ metadata: unknown }[]>`SELECT metadata FROM node_history WHERE id = ${history}`)[0]!.metadata,
      ];
      await migrate(tx);
      const first = await read();
      await migrate(tx);
      return { first, second: await read() };
    });

    expect(rows.second).toEqual(rows.first);
  });
});
