// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * S6e E4 schema (inner#1306 test plan §90 E4-4, E4-8, E4-1; frames-split design §7.15).
 *
 *   1. `presentation_pins`: one row per holder (five kinds) and toolInputId, soft deleted on `Rel`; a row is live
 *      exactly when `deleted_at IS NULL`. Partial unique indexes keep one live `selected` row per canonical key and
 *      make a repeated `Acq` of the same holder, toolInputId and prepared key collide instead of duplicating.
 *   2. `presentation_pin_objects`: the object keys each pin references, written when the pin is acquired; the
 *      reclaim consumer checks a `derived` key only against these rows of live pins.
 *   3. `storage_reclaim_queue.kind` (`dedup_loser`, `derived`); a `derived` row has no kept key, content hash,
 *      source or Studio, while a `dedup_loser` row keeps all four (its consumer path is unchanged).
 *
 * Column and index names are the test author's choices recorded in §90 (open to veto). Rejections are asserted
 * by SQLSTATE: 23514 check, 23505 unique, 23503 foreign key, 23502 not null. Without the migration every case
 * fails on 42P01 / 42703 (the object does not exist).
 */

import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

let sql: ReturnType<typeof postgres>;
const T = "c".repeat(64);
const T2 = "b".repeat(64);

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false, connection: { application_name: "presentation-pins-schema-test" } });
});
afterAll(async () => { await sql?.end({ timeout: 1 }); });

/**
 * The SQLSTATE a statement fails with, or null when it succeeds.
 * @param query - The statement.
 * @returns The code.
 */
async function codeOf(query: PromiseLike<unknown>): Promise<string | null> {
  try { await query; return null; } catch (error) { return (error as { code?: string }).code ?? "unknown"; }
}

/**
 * The columns of a table as the database reports them.
 * @param table - The table.
 * @returns Name to type and nullability.
 */
async function columnsOf(table: string): Promise<Record<string, { type: string; nullable: boolean }>> {
  const rows = await sql<{ column_name: string; data_type: string; is_nullable: string }[]>`
    SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table}`;
  return Object.fromEntries(rows.map((row) => [row.column_name, { type: row.data_type, nullable: row.is_nullable === "YES" }]));
}

/**
 * Insert one pin row.
 * @param fields - Column values that differ from a live execution pin of T.
 * @returns The statement.
 */
function pin(fields: Record<string, unknown> = {}): ReturnType<typeof sql> {
  const row = { holder_kind: "execution", holder_id: randomUUID(), tool_input_id: T, prepared_key: null, version_id: null, ...fields };
  return sql`INSERT INTO presentation_pins ${sql(row)} RETURNING id`;
}

describe("presentation_pins (E4-4)", () => {
  it("PS01 has the holder, toolInputId, prepared key, version and soft-delete columns", async () => {
    const columns = await columnsOf("presentation_pins");
    expect(columns).toMatchObject({
      id: { type: "uuid", nullable: false }, holder_kind: { nullable: false }, holder_id: { type: "text", nullable: false },
      // frames-split §7.15: a candidate may not know its toolInputId yet; every other kind records it (PS07).
      tool_input_id: { nullable: true }, prepared_key: { type: "text", nullable: true }, version_id: { nullable: true },
      created_at: { type: "timestamp with time zone", nullable: false }, updated_at: { type: "timestamp with time zone", nullable: false },
      deleted_at: { type: "timestamp with time zone", nullable: true },
    });
  });

  it.each(["execution", "analysis", "candidate"])("PS02 accepts a live %s pin", async (kind) => {
    expect(await codeOf(pin({ holder_kind: kind }))).toBeNull();
  });

  it("PS02 accepts a prepared pin with its prepared key and a selected pin with its version", async () => {
    expect(await codeOf(pin({ holder_kind: "prepared", prepared_key: `video/s.${randomUUID()}:prep:0:a1` }))).toBeNull();
    expect(await codeOf(pin({ holder_kind: "selected", holder_id: `video/${randomUUID()}.mp4`, version_id: "e".repeat(64) }))).toBeNull();
  });

  it.each(["generation", "", "Execution"])("PS03 refuses holder kind %j", async (kind) => {
    expect(await codeOf(pin({ holder_kind: kind }))).toBe("23514");
  });

  it("PS04 keeps one live selected row per canonical key", async () => {
    const holder = `video/${randomUUID()}.mp4`;
    expect(await codeOf(pin({ holder_kind: "selected", holder_id: holder, version_id: "e".repeat(64) }))).toBeNull();
    expect(await codeOf(pin({ holder_kind: "selected", holder_id: holder, tool_input_id: T2, version_id: "f".repeat(64) }))).toBe("23505");
  });

  it("PS05 a repeated live Acq of the same holder and toolInputId collides; another toolInputId does not", async () => {
    const holder = randomUUID();
    expect(await codeOf(pin({ holder_id: holder }))).toBeNull();
    expect(await codeOf(pin({ holder_id: holder }))).toBe("23505");
    expect(await codeOf(pin({ holder_id: holder, tool_input_id: T2 }))).toBeNull();
  });

  it("PS05 one execution holds one prepared row per prepared key", async () => {
    const holder = randomUUID(); const key = `video/s.${holder}:prep:0:a1`;
    expect(await codeOf(pin({ holder_kind: "prepared", holder_id: holder, prepared_key: key }))).toBeNull();
    expect(await codeOf(pin({ holder_kind: "prepared", holder_id: holder, prepared_key: key }))).toBe("23505");
    expect(await codeOf(pin({ holder_kind: "prepared", holder_id: holder, prepared_key: `${key}x` }))).toBeNull();
  });

  it("PS07 only a candidate pin may leave its toolInputId unknown", async () => {
    expect(await codeOf(pin({ holder_kind: "candidate", tool_input_id: null }))).toBeNull();
    expect(await codeOf(pin({ tool_input_id: null }))).toBe("23514");
    expect(await codeOf(pin({ holder_kind: "analysis", tool_input_id: null }))).toBe("23514");
    expect(await codeOf(pin({ holder_kind: "selected", holder_id: `video/${randomUUID()}.mp4`, tool_input_id: null, version_id: "e".repeat(64) }))).toBe("23514");
  });

  it("PS08 a presentation job holds one live candidate row, whatever toolInputId it records", async () => {
    const holder = `pres-${randomUUID()}`;
    expect(await codeOf(pin({ holder_kind: "candidate", holder_id: holder, tool_input_id: null }))).toBeNull();
    expect(await codeOf(pin({ holder_kind: "candidate", holder_id: holder, tool_input_id: T2 }))).toBe("23505");
  });

  it("PS06 a released (soft-deleted) row stays and does not block a new live row", async () => {
    const holder = randomUUID();
    const [first] = await pin({ holder_id: holder }) as unknown as { id: string }[];
    await sql`UPDATE presentation_pins SET deleted_at = now() WHERE id = ${first!.id}`;
    expect(await codeOf(pin({ holder_id: holder }))).toBeNull();
    const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM presentation_pins WHERE holder_id = ${holder}`;
    expect(count!.n).toBe(2);
    const selected = `video/${randomUUID()}.mp4`;
    const [old] = await pin({ holder_kind: "selected", holder_id: selected, version_id: "e".repeat(64) }) as unknown as { id: string }[];
    await sql`UPDATE presentation_pins SET deleted_at = now() WHERE id = ${old!.id}`;
    expect(await codeOf(pin({ holder_kind: "selected", holder_id: selected, version_id: "f".repeat(64) }))).toBeNull();
  });
});

describe("presentation_pin_objects (E4-8)", () => {
  it("PO01 records each referenced key of a pin once, with created_at", async () => {
    const columns = await columnsOf("presentation_pin_objects");
    expect(columns).toMatchObject({ pin_id: { type: "uuid", nullable: false }, storage_key: { type: "text", nullable: false }, created_at: { type: "timestamp with time zone", nullable: false } });
    const [row] = await pin() as unknown as { id: string }[];
    const key = `video/${randomUUID()}.mp4.video-source-ledger.${T}.json`;
    expect(await codeOf(sql`INSERT INTO presentation_pin_objects (pin_id, storage_key) VALUES (${row!.id}, ${key})`)).toBeNull();
    expect(await codeOf(sql`INSERT INTO presentation_pin_objects (pin_id, storage_key) VALUES (${row!.id}, ${key})`)).toBe("23505");
  });

  it("PO02 refuses a key of a pin that does not exist", async () => {
    expect(await codeOf(sql`INSERT INTO presentation_pin_objects (pin_id, storage_key) VALUES (${randomUUID()}, ${"video/x.json"})`)).toBe("23503");
  });

  it("PO03 a pin with referenced keys cannot be hard-deleted (foreign key restrict)", async () => {
    const [row] = await pin() as unknown as { id: string }[];
    await sql`INSERT INTO presentation_pin_objects (pin_id, storage_key) VALUES (${row!.id}, ${`video/${randomUUID()}.json`})`;
    expect(await codeOf(sql`DELETE FROM presentation_pins WHERE id = ${row!.id}`)).toBe("23503");
  });

  it("PO04 finds the live pins of a key through an index on storage_key", async () => {
    const [index] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'presentation_pin_objects' AND indexdef ILIKE '%(storage_key%'`;
    expect(index!.n).toBeGreaterThan(0);
  });
});

describe("storage_reclaim_queue.kind (E4-1, design §7.15 回收队列)", () => {
  /**
   * A Studio the dedup rows can name.
   * @returns Its id.
   */
  async function studio(): Promise<string> {
    const suffix = randomUUID();
    const [user] = await sql<{ id: string }[]>`INSERT INTO users(email,email_verified) VALUES(${`${suffix}@pins-schema.test`},true) RETURNING id`;
    const [row] = await sql<{ id: string }[]>`INSERT INTO studios(created_by_user_id,slug,type,name) VALUES(${user!.id},${`p-${suffix}`},'team','Pins schema') RETURNING id`;
    return row!.id;
  }

  it("RQ01 has a kind column that defaults existing and new dedup rows to dedup_loser", async () => {
    expect((await columnsOf("storage_reclaim_queue")).kind).toMatchObject({ nullable: false });
    const studioId = await studio();
    const [row] = await sql<{ kind: string }[]>`INSERT INTO storage_reclaim_queue(storage_key,content_hash,studio_id,kept_storage_key,source)
      VALUES(${`uploads/${randomUUID()}.png`},${randomBytes(32).toString("hex")},${studioId},${`uploads/${randomUUID()}.png`},'upload') RETURNING kind`;
    expect(row!.kind).toBe("dedup_loser");
  });

  it("RQ02 a derived row carries only its key: no kept key, content hash, source or Studio", async () => {
    const key = `video/${randomUUID()}.mp4.video-source-ledger.${T}.json`;
    const [row] = await sql<Record<string, unknown>[]>`INSERT INTO storage_reclaim_queue(storage_key,kind) VALUES(${key},'derived')
      RETURNING kind,kept_storage_key,content_hash,source,studio_id`;
    expect(row).toEqual({ kind: "derived", kept_storage_key: null, content_hash: null, source: null, studio_id: null });
  });

  it.each(["", "upright", "Derived"])("RQ03 refuses kind %j", async (kind) => {
    expect(await codeOf(sql`INSERT INTO storage_reclaim_queue(storage_key,kind) VALUES(${`video/${randomUUID()}.json`},${kind})`)).toBe("23514");
  });

  it.each(["kept_storage_key", "content_hash", "source", "studio_id"])("RQ04 a dedup_loser row still requires %s", async (column) => {
    const studioId = await studio();
    const row: Record<string, unknown> = { storage_key: `uploads/${randomUUID()}.png`, kind: "dedup_loser", content_hash: randomBytes(32).toString("hex"),
      studio_id: studioId, kept_storage_key: `uploads/${randomUUID()}.png`, source: "upload" };
    row[column] = null;
    expect(["23514", "23502"]).toContain(await codeOf(sql`INSERT INTO storage_reclaim_queue ${sql(row)}`));
  });

  it("RQ05 a derived key is queued once (the storage_key unique index is unchanged, E4-10)", async () => {
    const key = `video/${randomUUID()}.mp4.prep.json`;
    expect(await codeOf(sql`INSERT INTO storage_reclaim_queue(storage_key,kind) VALUES(${key},'derived')`)).toBeNull();
    expect(await codeOf(sql`INSERT INTO storage_reclaim_queue(storage_key,kind) VALUES(${key},'derived')`)).toBe("23505");
  });
});
