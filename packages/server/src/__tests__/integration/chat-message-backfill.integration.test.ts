// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The backfill that moves messages out of the old JSONB column.
 *
 * It runs exactly once, against data that only exists before it runs, so there
 * is no state left afterwards to assert on: by the time any test could look,
 * the column is gone. Verifying it therefore means reconstructing the "before"
 * — the old column, with messages in it — and running the migration's own
 * statement against that.
 *
 * The statement is READ OUT OF THE MIGRATION FILE rather than copied here. A
 * copy would pass while the shipped statement drifts away from it, which is
 * the one failure this suite exists to prevent. Everything happens inside a
 * transaction that is rolled back, so the reconstructed column never outlives
 * the test.
 */

import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { readFileSync } from "node:fs";
import postgres from "postgres";

const PG_DRIVER_LOCAL = "chat-message-backfill-test-driver";

const MIGRATION_PATH = new URL(
  "../../../../core/src/db/migrations/0050_chat_message_store.sql",
  import.meta.url,
);

/**
 * Pull the backfill statement out of the migration file.
 * @returns The SQL between the file's backfill markers.
 * @throws {Error} when the markers are missing — the migration was edited in a
 *   way that leaves this suite verifying nothing, which must fail loudly
 *   rather than silently pass.
 */
function readBackfillStatement(): string {
  const text = readFileSync(MIGRATION_PATH, "utf8");
  const start = text.indexOf("-- >>> backfill");
  const end = text.indexOf("-- <<< backfill");
  if (start === -1 || end === -1) {
    throw new Error("backfill markers missing from 0050 — nothing to verify");
  }
  return text.slice(start + "-- >>> backfill".length, end);
}

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: PG_DRIVER_LOCAL },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/** Thrown to roll the reconstruction back; never escapes the test. */
const ROLLBACK = new Error("rollback");

type BackfilledRow = {
  role: string;
  turn_index: number;
  seq: number;
  parts: unknown;
  created_at: Date;
};

describe("the 0050 backfill", () => {
  it("carries every message across with its order, shape and time intact", async () => {
    const backfill = readBackfillStatement();
    let rows: BackfilledRow[] = [];

    // The five shapes that ever reached the old column, in the order a real
    // turn produces them. Handed over with `tx.json` rather than a stringified
    // literal: postgres.js encodes a plain string as a JSON string, so the
    // column would end up holding one scalar instead of an array of messages,
    // and the backfill would have nothing to explode.
    const legacy = [
      { role: "user", content: "draw me a cat", ts: "2026-01-01T00:00:00.000Z", turnIndex: 1 },
      {
        role: "assistant",
        content: "",
        ts: "2026-01-01T00:00:01.000Z",
        turnIndex: 1,
        tool_calls: [
          { id: "call-1", name: "web_search", arguments: { q: "cat" }, result: { hits: 3 } },
        ],
      },
      {
        role: "tool",
        content: "three results",
        ts: "2026-01-01T00:00:02.000Z",
        turnIndex: 1,
        tool_call_id: "call-1",
        name: "web_search",
      },
      {
        role: "assistant",
        content: "here you go",
        ts: "2026-01-01T00:00:03.000Z",
        turnIndex: 1,
        thinking: "the user wants a cat",
      },
      { role: "user", content: "now a dog", ts: "2026-01-01T00:00:04.000Z", turnIndex: 2 },
    ];

    try {
      await sql.begin(async (tx) => {
        // Reconstruct the world as it was before this migration.
        await tx`ALTER TABLE conversations ADD COLUMN messages jsonb DEFAULT '[]'::jsonb`;

        const [user] = await tx<{ id: string }[]>`
          INSERT INTO users (email, email_verified)
          VALUES ('backfill-probe@example.com', true) RETURNING id
        `;
        const [conv] = await tx<{ id: string }[]>`
          INSERT INTO conversations (user_id, title, messages)
          VALUES (${user!.id}, 'legacy', ${tx.json(legacy)})
          RETURNING id
        `;

        await tx.unsafe(backfill);

        rows = await tx<BackfilledRow[]>`
          SELECT role, turn_index, seq, parts, created_at
          FROM conversation_messages
          WHERE conversation_id = ${conv!.id}
          ORDER BY turn_index, seq
        `;

        throw ROLLBACK;
      });
    } catch (err) {
      if (err !== ROLLBACK) throw err;
    }

    // Nothing is dropped and nothing is invented.
    expect(rows).toHaveLength(legacy.length);

    // Order survives: `WITH ORDINALITY` is what preserves it, and without it
    // the element order coming back out of a jsonb array is not something to
    // rely on.
    expect(rows.map((r) => [r.turn_index, r.seq])).toEqual([
      [1, 0],
      [1, 1],
      [1, 2],
      [1, 3],
      [2, 0],
    ]);
    expect(rows.map((r) => r.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
    ]);

    // Prose becomes a text part.
    expect(rows[0]!.parts).toEqual([{ type: "text", text: "draw me a cat" }]);

    // A tool call keeps its id, name, arguments and the result that drives
    // the frontend render.
    expect(rows[1]!.parts).toEqual([
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "web_search",
        input: { q: "cat" },
        output: { hits: 3 },
      },
    ]);

    // A tool message becomes exactly one tool-result part.
    expect(rows[2]!.parts).toEqual([
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "web_search",
        output: "three results",
      },
    ]);

    // Reasoning precedes the prose it produced.
    expect(rows[3]!.parts).toEqual([
      { type: "reasoning", text: "the user wants a cat" },
      { type: "text", text: "here you go" },
    ]);

    // The old `ts` becomes created_at — one timestamp, not two.
    expect(rows[0]!.created_at.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(rows[4]!.created_at.toISOString()).toBe("2026-01-01T00:00:04.000Z");
  });
});
