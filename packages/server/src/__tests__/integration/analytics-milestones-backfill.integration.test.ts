// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The 0096 backfill that claims the milestones accounts reached before
 * product analytics shipped (inner#1442 design §4.8, §4.16), so an existing
 * account's next project, Agent turn or generation is not reported as its
 * first, and a collaborator who already acted is not reported again.
 *
 * Like the 0050 suite, the statements are READ OUT OF THE MIGRATION FILE and
 * run against data built inside a transaction that is rolled back, since the
 * migration itself ran before any data existed.
 */

import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import postgres from "postgres";

const MIGRATION_PATH = new URL(
  "../../../../core/src/db/migrations/0096_analytics_consent_attribution.sql",
  import.meta.url,
);

/**
 * Pull the backfill statements out of the migration file.
 * @returns The statements between the backfill markers.
 * @throws {Error} When the markers are missing, so the suite fails rather than verifying nothing.
 */
function readBackfillStatements(): string[] {
  const text = readFileSync(MIGRATION_PATH, "utf8");
  const start = text.indexOf("-- >>> milestones backfill");
  const end = text.indexOf("-- <<< milestones backfill");
  if (start === -1 || end === -1) throw new Error("backfill markers missing from 0096 — nothing to verify");
  return text
    .slice(start, end)
    .split("--> statement-breakpoint")
    .filter((s) => s.includes("INSERT"));
}

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/** Thrown to roll the reconstruction back; never escapes the test. */
const ROLLBACK = new Error("rollback");

describe("the 0096 milestones backfill", () => {
  it("claims the firsts and collaborations reached before it ran, and nothing else", async () => {
    const statements = readBackfillStatements();
    expect(statements).toHaveLength(2);
    let keys: string[] = [];
    let ids: Record<string, string> = {};

    await sql
      .begin(async (tx) => {
        const user = async (): Promise<string> => {
          const [row] = await tx<{ id: string }[]>`
            INSERT INTO users (email) VALUES (${`backfill-${crypto.randomUUID()}@example.test`}) RETURNING id`;
          return row!.id;
        };
        const owner = await user();
        const collaborator = await user();
        const failedOnly = await user();
        const joinedOnly = await user();
        const [studio] = await tx<{ id: string }[]>`
          INSERT INTO studios (created_by_user_id, slug, type, name)
          VALUES (${owner}, ${`bf-${crypto.randomUUID().slice(0, 8)}`}, 'team', 'Team') RETURNING id`;
        const [project] = await tx<{ id: string }[]>`
          INSERT INTO projects (studio_id, created_by_user_id, name, slug)
          VALUES (${studio!.id}, ${owner}, 'P', ${`p-${crypto.randomUUID().slice(0, 8)}`}) RETURNING id`;
        const [conversation] = await tx<{ id: string }[]>`
          INSERT INTO conversations (user_id, project_id) VALUES (${owner}, ${project!.id}) RETURNING id`;
        const reply = (userId: string, parts: unknown, turn: number) => tx`
          INSERT INTO conversation_messages (conversation_id, user_id, role, turn_index, seq, parts)
          VALUES (${conversation!.id}, ${userId}, 'assistant', ${turn}, 1, ${tx.json(parts as postgres.JSONValue)})`;
        await reply(owner, [{ type: "text", text: "done" }], 0);
        await reply(failedOnly, [{ type: "failed" }], 1);
        await tx`
          INSERT INTO tasks (user_id, space_id, task_type, mode, status)
          VALUES (${owner}, ${crypto.randomUUID()}, 'image', 'direct', 'completed'),
                 (${failedOnly}, ${crypto.randomUUID()}, 'image', 'direct', 'failed')`;
        await tx`
          INSERT INTO project_activities (project_id, actor_user_id, type, payload)
          VALUES (${project!.id}, ${collaborator}, 'space:created', '{}'::jsonb),
                 (${project!.id}, ${joinedOnly}, 'member:joined', '{}'::jsonb)`;

        for (const statement of statements) await tx.unsafe(statement);
        const rows = await tx<{ key: string }[]>`
          SELECT key FROM analytics_milestones WHERE key LIKE ANY(${[owner, collaborator, failedOnly, joinedOnly].map((id) => `%${id}%`)})`;
        keys = rows.map((r) => r.key).sort();
        ids = { owner, collaborator, failedOnly, project: project!.id };
        throw ROLLBACK;
      })
      .catch((err: unknown) => {
        if (err !== ROLLBACK) throw err;
      });

    expect(keys).toEqual(
      [
        `collab:${ids.project}:${ids.collaborator}`,
        `first-agent:${ids.owner}`,
        `first-generation:${ids.owner}`,
        `first-project:${ids.owner}`,
      ].sort(),
    );
  });
});
