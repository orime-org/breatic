// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The six request tables end a request nobody could answer as `failed`, with
 * `failed_reason` saying why: `expired` when its deadline passed, `invalidated`
 * when what it was about stopped holding (inner#1023).
 *
 * Pinned here, against a real Postgres:
 *
 *   1. Each table's CHECKs: `status` takes only that table's own words, and a
 *      reason is present exactly on a failed row. `status` is a plain varchar
 *      to Drizzle, so the database is what refuses a writer still using the
 *      old word.
 *   2. The 0098 backfill, read out of the migration file and run against
 *      legacy rows built inside a transaction that is rolled back, since the
 *      migration itself ran before any data existed.
 *   3. The invitation reapers, which no other suite reaches through a repo.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// `ai` is stubbed: the real SDK is replaced with a double that reaches no
// network, so this suite needs no API key and the SDK stays out of its
// module graph.
vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

import { readFileSync } from "node:fs";
import postgres from "postgres";
import { db, initCore } from "@breatic/core";
import * as studioInvitationsRepo from "@server/modules/studio/studioInvitations.repo.js";
import * as projectInvitationsRepo from "@server/modules/project-invite/projectInvitations.repo.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

const MIGRATION_PATH = new URL(
  "../../../../core/src/db/migrations/0098_request_failed_reason.sql",
  import.meta.url,
);

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "request-failed-reason-test" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

interface Scene {
  userA: string;
  userB: string;
  studioId: string;
  projectId: string;
}

/**
 * Two users, a team studio and a project in it.
 * @returns Their ids.
 */
async function seedScene(): Promise<Scene> {
  const tag = `rfr-${seq++}`;
  const user = async (suffix: string): Promise<string> => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO users (email, email_verified) VALUES (${`${tag}-${suffix}@example.com`}, true) RETURNING id
    `;
    return row!.id;
  };
  const userA = await user("a");
  const userB = await user("b");
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userA}, ${`${tag}-studio`}, 'team', ${tag}) RETURNING id
  `;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studio!.id}, ${userA}, ${tag}, ${`${tag}-p`}) RETURNING id
  `;
  return { userA, userB, studioId: studio!.id, projectId: project!.id };
}

type Table =
  | "studio_invitations"
  | "project_invitations"
  | "role_upgrade_requests"
  | "project_join_requests"
  | "project_transfers"
  | "studio_transfers";

/** Every word each table's `status` accepts. */
const VOCABULARY: Record<Table, readonly string[]> = {
  studio_invitations: ["pending", "accepted", "declined", "revoked", "failed"],
  project_invitations: ["pending", "accepted", "declined", "revoked", "failed"],
  role_upgrade_requests: ["pending", "approved", "rejected", "cancelled", "failed"],
  project_join_requests: ["pending", "approved", "rejected", "cancelled", "failed"],
  project_transfers: ["pending", "accepted", "declined", "cancelled", "failed"],
  studio_transfers: ["pending", "accepted", "declined", "cancelled", "failed"],
};

const TABLES = Object.keys(VOCABULARY) as Table[];

/**
 * Insert one row into a request table with the given outcome.
 * @param q - The connection or transaction to write through.
 * @param table - Which table.
 * @param s - The scene the row belongs to.
 * @param row - The outcome and clock values to write.
 * @param row.status - The status word.
 * @param row.failedReason - The reason, or null.
 * @param row.expiresAt - SQL for the deadline; a week out when omitted.
 * @param row.updatedAt - SQL for the last update; now when omitted.
 * @returns The new row's id.
 */
async function insertRow(
  q: postgres.Sql | postgres.TransactionSql,
  table: Table,
  s: Scene,
  row: {
    status: string;
    failedReason: string | null;
    expiresAt?: postgres.Fragment;
    updatedAt?: postgres.Fragment;
  },
): Promise<string> {
  const expiresAt = row.expiresAt ?? q`now() + interval '7 days'`;
  const updatedAt = row.updatedAt ?? q`now()`;
  const token = q`replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','')`;
  const grantedRole = row.status === "approved" ? "viewer" : null;
  let rows: { id: string }[];
  switch (table) {
    case "studio_invitations":
      rows = await q<{ id: string }[]>`
        INSERT INTO studio_invitations
          (studio_id, invited_user_id, role, invited_by, status, failed_reason, expires_at, updated_at, share_token)
        VALUES (${s.studioId}, ${s.userB}, 'guest', ${s.userA}, ${row.status}, ${row.failedReason}, ${expiresAt}, ${updatedAt}, ${token})
        RETURNING id`;
      break;
    case "project_invitations":
      rows = await q<{ id: string }[]>`
        INSERT INTO project_invitations
          (project_id, invited_user_id, role, invited_by, status, failed_reason, expires_at, updated_at, share_token)
        VALUES (${s.projectId}, ${s.userB}, 'viewer', ${s.userA}, ${row.status}, ${row.failedReason}, ${expiresAt}, ${updatedAt}, ${token})
        RETURNING id`;
      break;
    case "role_upgrade_requests":
      rows = await q<{ id: string }[]>`
        INSERT INTO role_upgrade_requests
          (project_id, requester_user_id, requested_role, status, failed_reason, expires_at, updated_at, share_token)
        VALUES (${s.projectId}, ${s.userB}, 'editor', ${row.status}, ${row.failedReason}, ${expiresAt}, ${updatedAt}, ${token})
        RETURNING id`;
      break;
    case "project_join_requests":
      rows = await q<{ id: string }[]>`
        INSERT INTO project_join_requests
          (project_id, requester_user_id, status, granted_role, failed_reason, expires_at, updated_at, share_token)
        VALUES (${s.projectId}, ${s.userB}, ${row.status}, ${grantedRole}, ${row.failedReason}, ${expiresAt}, ${updatedAt}, ${token})
        RETURNING id`;
      break;
    case "project_transfers":
      rows = await q<{ id: string }[]>`
        INSERT INTO project_transfers
          (project_id, from_user_id, to_user_id, status, failed_reason, expires_at, updated_at, share_token)
        VALUES (${s.projectId}, ${s.userA}, ${s.userB}, ${row.status}, ${row.failedReason}, ${expiresAt}, ${updatedAt}, ${token})
        RETURNING id`;
      break;
    case "studio_transfers":
      rows = await q<{ id: string }[]>`
        INSERT INTO studio_transfers
          (studio_id, from_user_id, to_user_id, status, failed_reason, expires_at, updated_at, share_token)
        VALUES (${s.studioId}, ${s.userA}, ${s.userB}, ${row.status}, ${row.failedReason}, ${expiresAt}, ${updatedAt}, ${token})
        RETURNING id`;
      break;
  }
  return rows[0]!.id;
}

/**
 * Read a row's status and reason.
 * @param table - Which table.
 * @param id - The row.
 * @returns Its status and failure reason.
 */
async function outcomeOf(
  table: Table,
  id: string,
): Promise<{ status: string; failed_reason: string | null }> {
  const [row] = await sql<{ status: string; failed_reason: string | null }[]>`
    SELECT status, failed_reason FROM ${sql(table)} WHERE id = ${id}
  `;
  return row!;
}

describe.each(TABLES)("%s constraints", (table) => {
  it("accepts every word of its own vocabulary, with a reason only when failed", async () => {
    for (const status of VOCABULARY[table]) {
      const s = await seedScene();
      const failedReason = status === "failed" ? "expired" : null;
      const id = await insertRow(sql, table, s, { status, failedReason });
      expect(await outcomeOf(table, id)).toEqual({ status, failed_reason: failedReason });
    }
  });

  it("accepts both reasons on a failed row", async () => {
    for (const failedReason of ["expired", "invalidated"]) {
      const s = await seedScene();
      const id = await insertRow(sql, table, s, { status: "failed", failedReason });
      expect((await outcomeOf(table, id)).failed_reason).toBe(failedReason);
    }
  });

  it("refuses the retired word `expired` as a status", async () => {
    const s = await seedScene();
    await expect(
      insertRow(sql, table, s, { status: "expired", failedReason: null }),
    ).rejects.toThrow(new RegExp(`${table}_status_check`));
  });

  it("refuses a failed row without a reason", async () => {
    const s = await seedScene();
    await expect(
      insertRow(sql, table, s, { status: "failed", failedReason: null }),
    ).rejects.toThrow(new RegExp(`${table}_failed_reason_check`));
  });

  it("refuses a reason on a row that did not fail", async () => {
    const s = await seedScene();
    await expect(
      insertRow(sql, table, s, { status: "pending", failedReason: "expired" }),
    ).rejects.toThrow(new RegExp(`${table}_failed_reason_check`));
  });

  it("refuses a reason outside the two", async () => {
    const s = await seedScene();
    await expect(
      insertRow(sql, table, s, { status: "failed", failedReason: "timeout" }),
    ).rejects.toThrow(new RegExp(`${table}_failed_reason_check`));
  });

  it("refuses moving an existing row to the retired word", async () => {
    const s = await seedScene();
    const id = await insertRow(sql, table, s, { status: "pending", failedReason: null });
    await expect(
      sql`UPDATE ${sql(table)} SET status = 'expired' WHERE id = ${id}`,
    ).rejects.toThrow(new RegExp(`${table}_status_check`));
  });
});

/**
 * Pull the backfill statements out of the migration file.
 * @returns The statements between the backfill markers.
 * @throws {Error} When the markers are missing, so the suite fails rather than verifying nothing.
 */
function readBackfillStatements(): string[] {
  const text = readFileSync(MIGRATION_PATH, "utf8");
  const start = text.indexOf("-- >>> failed_reason backfill");
  const end = text.indexOf("-- <<< failed_reason backfill");
  if (start === -1 || end === -1) {
    throw new Error("backfill markers missing from 0098 — nothing to verify");
  }
  return text
    .slice(start, end)
    .split("--> statement-breakpoint")
    .filter((statement) => statement.includes("UPDATE"));
}

/** Thrown to roll the reconstruction back; never escapes the test. */
const ROLLBACK = new Error("rollback");

describe("the 0098 backfill", () => {
  it("turns every legacy `expired` row into `failed` and infers why from the clock", async () => {
    const statements = readBackfillStatements();
    expect(statements).toHaveLength(TABLES.length);
    const results: { table: Table; kind: string; outcome: unknown }[] = [];

    await sql
      .begin(async (tx) => {
        // The rows below predate the migration, so they are built with the
        // migration's own constraints lifted.
        for (const table of TABLES) {
          await tx`ALTER TABLE ${tx(table)} DROP CONSTRAINT ${tx(`${table}_status_check`)}`;
          await tx`ALTER TABLE ${tx(table)} DROP CONSTRAINT ${tx(`${table}_failed_reason_check`)}`;
        }
        const ids: { table: Table; kind: string; id: string }[] = [];
        for (const table of TABLES) {
          // Settled when its premise went away: the old writer pulled the
          // deadline to that moment and stamped updated_at in the same UPDATE.
          ids.push({
            table,
            kind: "premise gone",
            id: await insertRow(tx, table, await seedScene(), {
              status: "expired",
              failedReason: null,
              expiresAt: tx`now() - interval '3 days'`,
              updatedAt: tx`now() - interval '3 days' + interval '1 second'`,
            }),
          });
          // Reaped a day after its deadline passed.
          ids.push({
            table,
            kind: "timed out",
            id: await insertRow(tx, table, await seedScene(), {
              status: "expired",
              failedReason: null,
              expiresAt: tx`now() - interval '3 days'`,
              updatedAt: tx`now() - interval '2 days'`,
            }),
          });
          // Answered, so the backfill leaves it alone.
          ids.push({
            table,
            kind: "declined",
            id: await insertRow(tx, table, await seedScene(), {
              status: VOCABULARY[table][2]!,
              failedReason: null,
            }),
          });
        }

        for (const statement of statements) await tx.unsafe(statement);

        for (const { table, kind, id } of ids) {
          const [row] = await tx<{ status: string; failed_reason: string | null }[]>`
            SELECT status, failed_reason FROM ${tx(table)} WHERE id = ${id}
          `;
          results.push({ table, kind, outcome: row });
        }
        throw ROLLBACK;
      })
      .catch((err: unknown) => {
        if (err !== ROLLBACK) throw err;
      });

    for (const table of TABLES) {
      const of = (kind: string): unknown => results.find((r) => r.table === table && r.kind === kind)?.outcome;
      expect(of("premise gone"), table).toEqual({ status: "failed", failed_reason: "invalidated" });
      expect(of("timed out"), table).toEqual({ status: "failed", failed_reason: "expired" });
      expect(of("declined"), table).toEqual({ status: VOCABULARY[table][2], failed_reason: null });
    }
  });
});

describe("the invitation reapers", () => {
  it("fail a timed-out studio invite as expired and keep its deadline", async () => {
    const s = await seedScene();
    const id = await insertRow(sql, "studio_invitations", s, {
      status: "pending",
      failedReason: null,
      expiresAt: sql`now() - interval '1 day'`,
    });
    const [before] = await sql<{ expires_at: Date }[]>`SELECT expires_at FROM studio_invitations WHERE id = ${id}`;

    await db.transaction((tx) => studioInvitationsRepo.expireStalePending(s.studioId, s.userB, tx));

    expect(await outcomeOf("studio_invitations", id)).toEqual({ status: "failed", failed_reason: "expired" });
    const [after] = await sql<{ expires_at: Date }[]>`SELECT expires_at FROM studio_invitations WHERE id = ${id}`;
    expect(after!.expires_at.getTime()).toBe(before!.expires_at.getTime());
  });

  it("fail a timed-out project invite as expired", async () => {
    const s = await seedScene();
    const id = await insertRow(sql, "project_invitations", s, {
      status: "pending",
      failedReason: null,
      expiresAt: sql`now() - interval '1 day'`,
    });

    await db.transaction((tx) => projectInvitationsRepo.expireStalePending(s.projectId, s.userB, tx));

    expect(await outcomeOf("project_invitations", id)).toEqual({ status: "failed", failed_reason: "expired" });
  });
});
