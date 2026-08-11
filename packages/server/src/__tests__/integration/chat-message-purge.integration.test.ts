// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Clearing out the rows migration 0050 wrote in a shape nothing reads.
 *
 * 0050 moved messages out of a JSONB column into a row each, translating the
 * old flat fields as it went: a `role='tool'` message became a `tool-result`
 * part, and each entry of `tool_calls` a `tool-call` part. This branch then
 * replaced both of those part types with a single `tool` part carrying a
 * status, and narrowed `role` to user and assistant. So every row 0050
 * backfilled is now written in a vocabulary the readers no longer have: the
 * panel filters those parts out, the model never sees them, and a
 * `role='tool'` row amounts to nothing at all.
 *
 * They are cleared rather than translated because no such conversation is
 * worth keeping — chat has never run anywhere but a developer's own database,
 * so there is no history to preserve, and writing a translation would be
 * writing a migration for data that does not exist. Cleared means soft
 * deleted, which is what this repository does with every table.
 *
 * The statement is READ OUT OF THE MIGRATION FILE rather than copied here, so
 * this cannot pass while the shipped statement drifts away from it.
 */

import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { readFileSync } from "node:fs";
import postgres from "postgres";

const PG_DRIVER_LOCAL = "chat-message-purge-test-driver";

const MIGRATION_PATH = new URL(
  "../../../../core/src/db/migrations/0051_purge_pre_parts_messages.sql",
  import.meta.url,
);

/**
 * Pull the purge statement out of the migration file.
 * @returns The SQL between the file's purge markers
 * @throws {Error} when the markers are missing — the migration was edited in a
 *   way that leaves this suite verifying nothing, which must fail loudly
 *   rather than silently pass
 */
function readPurgeStatement(): string {
  const text = readFileSync(MIGRATION_PATH, "utf8");
  const start = text.indexOf("-- >>> purge");
  const end = text.indexOf("-- <<< purge");
  if (start === -1 || end === -1) {
    throw new Error("purge markers missing from 0051 — this suite would verify nothing");
  }
  return text.slice(start + "-- >>> purge".length, end);
}

let sql: postgres.Sql;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), { max: 2, connection: { application_name: PG_DRIVER_LOCAL } });
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

let seq = 0;

/**
 * Seed one conversation to hang messages off.
 * @param tx - The transaction to work in
 * @returns The ids a message row needs
 */
async function seedConversation(
  tx: postgres.TransactionSql,
): Promise<{ conversationId: string; userId: string }> {
  const tag = `purge-${seq++}-${process.hrtime.bigint() % 100000n}`;
  const [user] = await tx<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`${tag}@example.com`}, true) RETURNING id
  `;
  const [studio] = await tx<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`${tag}-studio`}, 'personal', ${tag}) RETURNING id
  `;
  const [project] = await tx<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug, visibility)
    VALUES (${studio!.id}, ${user!.id}, ${tag}, ${`${tag}-p`}, 'studio') RETURNING id
  `;
  const [conversation] = await tx<{ id: string }[]>`
    INSERT INTO conversations (user_id, project_id, title)
    VALUES (${user!.id}, ${project!.id}, ${tag}) RETURNING id
  `;
  return { conversationId: conversation!.id, userId: user!.id };
}

describe("clearing out rows written in the shape nothing reads", () => {
  it("clears a message whose parts speak the old vocabulary", async () => {
    await sql
      .begin(async (tx) => {
        const { conversationId, userId } = await seedConversation(tx);
        const oldShape = [
          { type: "tool-call", toolCallId: "tc-1", toolName: "web_search", input: {} },
        ];
        const [row] = await tx`
          INSERT INTO conversation_messages (conversation_id, user_id, role, turn_index, seq, parts)
          VALUES (${conversationId}, ${userId}, 'assistant', 1, 0, ${tx.json(oldShape)})
          RETURNING id`;

        await tx.unsafe(readPurgeStatement());

        const [after] = await tx`
          SELECT deleted_at FROM conversation_messages WHERE id = ${row!.id}`;
        expect(after!.deleted_at).not.toBeNull();
        throw new Error("rollback");
      })
      .catch((e: Error) => {
        if (e.message !== "rollback") throw e;
      });
  });

  it("clears a message that was a tool role of its own", async () => {
    await sql
      .begin(async (tx) => {
        const { conversationId, userId } = await seedConversation(tx);
        const oldShape = [
          { type: "tool-result", toolCallId: "tc-1", toolName: "web_search", output: "two links" },
        ];
        const [row] = await tx`
          INSERT INTO conversation_messages (conversation_id, user_id, role, turn_index, seq, parts)
          VALUES (${conversationId}, ${userId}, 'tool', 1, 0, ${tx.json(oldShape)})
          RETURNING id`;

        await tx.unsafe(readPurgeStatement());

        const [after] = await tx`
          SELECT deleted_at FROM conversation_messages WHERE id = ${row!.id}`;
        expect(after!.deleted_at).not.toBeNull();
        throw new Error("rollback");
      })
      .catch((e: Error) => {
        if (e.message !== "rollback") throw e;
      });
  });

  it("leaves a message written in the shape the readers do have", async () => {
    await sql
      .begin(async (tx) => {
        const { conversationId, userId } = await seedConversation(tx);
        const currentShape = [
          { type: "text", text: "here you go" },
          {
            type: "tool",
            toolCallId: "tc-1",
            toolName: "web_search",
            input: {},
            status: "success",
            output: "two links",
          },
        ];
        const [row] = await tx`
          INSERT INTO conversation_messages (conversation_id, user_id, role, turn_index, seq, parts)
          VALUES (${conversationId}, ${userId}, 'assistant', 1, 0, ${tx.json(currentShape)})
          RETURNING id`;

        await tx.unsafe(readPurgeStatement());

        // The judgement has to be the vocabulary, not "everything that was
        // there before" — a purge that cannot tell them apart takes the
        // conversation the developer is in the middle of with it.
        const [after] = await tx`
          SELECT deleted_at FROM conversation_messages WHERE id = ${row!.id}`;
        expect(after!.deleted_at).toBeNull();
        throw new Error("rollback");
      })
      .catch((e: Error) => {
        if (e.message !== "rollback") throw e;
      });
  });
});
