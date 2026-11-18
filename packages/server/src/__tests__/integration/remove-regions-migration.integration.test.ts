// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** Migration 0127 takes back what 0126 added for regions (#1556). */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

const migrations = new URL("../../../../core/src/db/migrations/", import.meta.url);
let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false, onnotice: () => {}, connection: { application_name: "remove-regions-migration-test" } });
});
afterAll(async () => {
  await sql?.end({ timeout: 3 });
});

type Tx = postgres.TransactionSql;
class Rollback extends Error {}

/** The tables 0126 created for regions. */
const REGION_TABLES = [
  "studio_directory",
  "studio_directory_members",
  "project_directory",
  "user_regions",
  "slug_reservations",
  "credit_charge_settlements",
  "studio_storage_usage_global",
  "region_outbox_applied",
  "directory_reconciliations",
  "region_outbox",
  "region_outbox_dead_letters",
  "studio_creation_tombstones",
];

/** Every foreign key 0126 dropped: name, table, column, referenced table, ON DELETE (r = restrict, a = no action). */
const FOREIGN_KEYS: Array<[string, string, string, string, "r" | "a"]> = [
  ["account_activity_events_user_id_fkey", "account_activity_events", "user_id", "users", "r"],
  ["agent_memories_user_id_fkey", "agent_memories", "user_id", "users", "r"],
  ["agent_usage_records_actor_user_id_users_id_fk", "agent_usage_records", "actor_user_id", "users", "r"],
  ["conversation_attachments_user_id_users_id_fk", "conversation_attachments", "user_id", "users", "a"],
  ["conversation_messages_user_id_users_id_fk", "conversation_messages", "user_id", "users", "r"],
  ["conversations_user_id_users_id_fk", "conversations", "user_id", "users", "r"],
  ["credit_charge_requests_actor_user_id_fk", "credit_charge_requests", "actor_user_id", "users", "r"],
  ["credit_compensations_studio_fk", "credit_compensations", "personal_studio_id", "studios", "r"],
  ["credit_gifts_studio_fk", "credit_gifts", "personal_studio_id", "studios", "r"],
  ["credit_holds_studio_id_fk", "credit_holds", "studio_id", "studios", "r"],
  ["credit_ledger_project_id_fk", "credit_ledger", "project_id", "projects", "r"],
  ["credit_ledger_studio_id_fk", "credit_ledger", "studio_id", "studios", "r"],
  ["credit_lots_designated_studio_id_fk", "credit_lots", "designated_studio_id", "studios", "r"],
  ["credit_settlement_receipts_actor_user_id_fk", "credit_settlement_receipts", "actor_user_id", "users", "r"],
  ["document_versions_created_by_user_id_fkey", "document_versions", "created_by_user_id", "users", "r"],
  ["document_versions_deleted_by_user_id_fkey", "document_versions", "deleted_by_user_id", "users", "r"],
  ["media_understanding_attempts_approval_actor_fk", "media_understanding_attempts", "approval_actor_user_id", "users", "r"],
  ["media_understanding_operations_actor_user_id_fk", "media_understanding_operations", "actor_user_id", "users", "r"],
  ["node_history_user_id_users_id_fk", "node_history", "user_id", "users", "r"],
  ["node_tasks_started_by_user_id_users_id_fk", "node_tasks", "started_by_user_id", "users", "r"],
  ["notifications_user_id_users_id_fk", "notifications", "user_id", "users", "r"],
  ["project_activities_actor_user_id_users_id_fk", "project_activities", "actor_user_id", "users", "r"],
  ["project_agent_instructions_updated_by_fk", "project_agent_instructions", "updated_by_user_id", "users", "r"],
  ["project_invitations_invited_by_users_id_fk", "project_invitations", "invited_by", "users", "r"],
  ["project_invitations_invited_user_id_users_id_fk", "project_invitations", "invited_user_id", "users", "r"],
  ["project_join_requests_decided_by_user_id_users_id_fk", "project_join_requests", "decided_by_user_id", "users", "r"],
  ["project_join_requests_requester_user_id_users_id_fk", "project_join_requests", "requester_user_id", "users", "r"],
  ["project_last_opened_user_id_users_id_fk", "project_last_opened", "user_id", "users", "r"],
  ["project_members_added_by_users_id_fk", "project_members", "added_by", "users", "r"],
  ["project_members_user_id_users_id_fk", "project_members", "user_id", "users", "r"],
  ["project_memories_user_id_users_id_fk", "project_memories", "user_id", "users", "r"],
  ["project_memory_entries_author_id_users_id_fk", "project_memory_entries", "author_id", "users", "a"],
  ["project_transfers_from_user_id_users_id_fk", "project_transfers", "from_user_id", "users", "r"],
  ["project_transfers_to_user_id_users_id_fk", "project_transfers", "to_user_id", "users", "r"],
  ["projects_archived_by_user_id_users_id_fk", "projects", "archived_by_user_id", "users", "r"],
  ["projects_created_by_user_id_users_id_fk", "projects", "created_by_user_id", "users", "r"],
  ["role_upgrade_requests_decided_by_user_id_users_id_fk", "role_upgrade_requests", "decided_by_user_id", "users", "r"],
  ["role_upgrade_requests_requester_user_id_users_id_fk", "role_upgrade_requests", "requester_user_id", "users", "r"],
  ["studio_assets_produced_by_user_id_users_id_fk", "studio_assets", "produced_by_user_id", "users", "r"],
  ["studio_credit_debts_studio_id_fk", "studio_credit_debts", "studio_id", "studios", "r"],
  ["studio_invitations_invited_by_users_id_fk", "studio_invitations", "invited_by", "users", "r"],
  ["studio_invitations_invited_user_id_users_id_fk", "studio_invitations", "invited_user_id", "users", "r"],
  ["studio_members_added_by_users_id_fk", "studio_members", "added_by", "users", "r"],
  ["studio_members_user_id_users_id_fk", "studio_members", "user_id", "users", "r"],
  ["studio_transfers_from_user_id_users_id_fk", "studio_transfers", "from_user_id", "users", "r"],
  ["studio_transfers_to_user_id_users_id_fk", "studio_transfers", "to_user_id", "users", "r"],
  ["studios_owner_user_id_users_id_fk", "studios", "created_by_user_id", "users", "r"],
  ["tasks_user_id_users_id_fk", "tasks", "user_id", "users", "r"],
  ["timeline_executions_actor_user_id_fkey", "timeline_executions", "actor_user_id", "users", "r"],
  ["upload_grants_user_id_users_id_fk", "upload_grants", "user_id", "users", "r"],
  ["usage_settlement_envelopes_actor_user_id_fk", "usage_settlement_envelopes", "actor_user_id", "users", "r"],
];

/**
 * The statements of one migration file.
 * @param file - The migration's file name.
 * @returns Its statements, split where the file breaks them.
 */
async function statementsOf(file: string): Promise<string[]> {
  return (await readFile(new URL(file, migrations), "utf8")).split("--> statement-breakpoint").filter((s) => s.trim().length > 0);
}

/**
 * Run statements in order inside the transaction.
 * @param tx - The transaction.
 * @param statements - The statements.
 */
async function run(tx: Tx, statements: string[]): Promise<void> {
  for (const statement of statements) await tx.unsafe(statement);
}

/**
 * Put the database back where 0126 left it, run the body, and roll everything back.
 * @param body - What to do on the 0126 schema.
 */
async function onRegionsSchema(body: (tx: Tx) => Promise<void>): Promise<void> {
  await sql
    .begin(async (tx) => {
      await run(tx, await statementsOf("0126_regions.sql"));
      await body(tx);
      throw new Rollback();
    })
    .catch((err: unknown) => {
      if (!(err instanceof Rollback)) throw err;
    });
}

/**
 * A user, their Studio with a Project, a credit hold and a pending transfer to a second member.
 * @param tx - The transaction.
 * @returns The Studio and the transfer it holds.
 */
async function seed(tx: Tx): Promise<{ studioId: string; transferId: string }> {
  const owner = randomUUID();
  const member = randomUUID();
  const studioId = randomUUID();
  for (const id of [owner, member]) await tx`INSERT INTO users (id, email) VALUES (${id}, ${`${id}@example.test`})`;
  await tx`INSERT INTO studios (id, created_by_user_id, slug, name, type) VALUES (${studioId}, ${owner}, ${studioId.slice(0, 30)}, 'Fixture', 'team')`;
  await tx`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${owner}, 'admin'), (${studioId}, ${member}, 'maintainer')`;
  await tx`INSERT INTO projects (studio_id, created_by_user_id, name, slug) VALUES (${studioId}, ${owner}, 'Fixture', ${`p-${studioId.slice(0, 20)}`})`;
  await tx`INSERT INTO credit_holds (studio_id, actor_user_id, reference_id, amount, expires_at) VALUES (${studioId}, ${owner}, ${randomUUID()}, '0.250000', now() + interval '1 hour')`;
  const [transfer] = await tx`
    INSERT INTO studio_transfers (studio_id, from_user_id, to_user_id, status, expires_at, share_token)
    VALUES (${studioId}, ${owner}, ${member}, 'pending', now() + interval '7 days', ${randomUUID().replaceAll("-", "")}) RETURNING id`;
  return { studioId, transferId: transfer!.id as string };
}

/**
 * Every business row the seed wrote for a Studio.
 * @param tx - The transaction.
 * @param studioId - The Studio.
 * @returns The rows, as JSON.
 */
async function rowsOf(tx: Tx, studioId: string): Promise<unknown> {
  const [row] = await tx`SELECT jsonb_build_object(
    'studio', (SELECT to_jsonb(t) FROM studios t WHERE id = ${studioId}),
    'members', (SELECT jsonb_agg(to_jsonb(t) ORDER BY user_id) FROM studio_members t WHERE studio_id = ${studioId}),
    'projects', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM projects t WHERE studio_id = ${studioId}),
    'holds', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM credit_holds t WHERE studio_id = ${studioId}),
    'transfers', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM studio_transfers t WHERE studio_id = ${studioId})
  ) AS rows`;
  return row!.rows;
}

/**
 * The foreign keys among the expected ones that exist, in the expected shape.
 * @param tx - A connection or transaction.
 * @returns name, table, column, referenced table and delete rule of each.
 */
async function foreignKeys(tx: Tx | ReturnType<typeof postgres>): Promise<Array<[string, string, string, string, string]>> {
  const rows = await tx`
    SELECT c.conname, owner.relname AS tbl, a.attname AS col, ref.relname AS ref, c.confdeltype AS del
    FROM pg_constraint c
    JOIN pg_class owner ON owner.oid = c.conrelid
    JOIN pg_class ref ON ref.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f' AND c.conname IN ${tx(FOREIGN_KEYS.map(([name]) => name))}
    ORDER BY c.conname`;
  return rows.map((r) => [r.conname, r.tbl, r.col, r.ref, r.del] as [string, string, string, string, string]);
}

/** The expected foreign keys, ordered as {@link foreignKeys} answers. */
const EXPECTED_KEYS = [...FOREIGN_KEYS].sort((a, b) => (a[0] < b[0] ? -1 : 1));

describe("migration 0127 removes regions", () => {
  it("leaves a fully migrated database without region tables or columns", async () => {
    const tables = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ${sql(REGION_TABLES)}`;
    expect(tables).toEqual([]);
    const columns = await sql`SELECT 1 FROM information_schema.columns WHERE table_name = 'credit_charge_requests' AND column_name = 'studio_id'`;
    expect(columns).toEqual([]);
  });

  it("restores every foreign key 0126 dropped under its original name and delete rule", async () => {
    expect(await foreignKeys(sql)).toEqual(EXPECTED_KEYS);
  });

  it("refuses a Studio transfer in the accepting state", async () => {
    await expect(
      sql.begin(async (tx) => {
        const { transferId } = await seed(tx);
        await tx`UPDATE studio_transfers SET status = 'accepting' WHERE id = ${transferId}`;
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("keeps a database's business rows and brings the keys back after 0126 ran", async () => {
    await onRegionsSchema(async (tx) => {
      const { studioId } = await seed(tx);
      expect(await foreignKeys(tx)).toEqual([]);
      const before = await rowsOf(tx, studioId);
      await run(tx, await statementsOf("0127_remove_regions.sql"));
      expect(await rowsOf(tx, studioId)).toEqual(before);
      expect(await foreignKeys(tx)).toEqual(EXPECTED_KEYS);
      const tables = await tx`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ${tx(REGION_TABLES)}`;
      expect(tables).toEqual([]);
    });
  });

  it("stops on a Studio transfer left accepting and names it", async () => {
    await onRegionsSchema(async (tx) => {
      const { transferId } = await seed(tx);
      await tx`UPDATE studio_transfers SET status = 'accepting' WHERE id = ${transferId}`;
      await expect(run(tx, await statementsOf("0127_remove_regions.sql"))).rejects.toThrow(transferId);
    });
  });
});
