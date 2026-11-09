// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Queries issued through `db` while a transaction is open in the same async
 * flow run on that transaction's connection (inner#1917). A transaction that
 * borrowed a second pool connection deadlocked the server once as many
 * uploads opened at once as the pool had connections.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { db, env, initCore, loadLocales } from "@breatic/core";
import { openUpload } from "@server/modules/asset/upload-opening.js";
import { seedActivityProject } from "./helpers/account-activity-fixture.js";

initCore({ ...process.env, PAYMENT_ENABLED: "false" });
loadLocales();

let probe: ReturnType<typeof postgres>;
const TABLE = `tx_bound_probe_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

beforeAll(async () => {
  probe = postgres(inject("DATABASE_URL"), { max: 2, prepare: false });
  await probe.unsafe(`CREATE TABLE ${TABLE} (id uuid PRIMARY KEY, note text NOT NULL)`);
});
afterAll(async () => {
  await probe.unsafe(`DROP TABLE IF EXISTS ${TABLE}`);
  await probe.end({ timeout: 1 });
});

/**
 * Write one probe row through the pool handle, never through a transaction.
 * @param note - What the row says.
 * @returns The row id.
 */
async function insertThroughDb(note: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`INSERT INTO ${sql.raw(TABLE)} (id, note) VALUES (${id}, ${note})`);
  return id;
}

/**
 * Read probe notes through the pool handle.
 * @returns Every note currently visible to that handle.
 */
async function notesThroughDb(): Promise<string[]> {
  const rows = await db.execute<{ note: string }>(sql`SELECT note FROM ${sql.raw(TABLE)} ORDER BY note`);
  return [...rows].map((row) => row.note);
}

/**
 * Read committed probe notes from a separate client.
 * @returns Every committed note.
 */
async function committedNotes(): Promise<string[]> {
  const rows = await probe.unsafe<{ note: string }[]>(`SELECT note FROM ${TABLE} ORDER BY note`);
  return rows.map((row) => row.note);
}

/**
 * Reject when a promise takes longer than the limit, so a deadlock fails the
 * test instead of hanging the run.
 * @param work - The work to wait for.
 * @param ms - The limit.
 * @returns What the work resolved to.
 * @throws {Error} When the limit passes first.
 */
async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}

describe("transaction-bound queries (inner#1917)", () => {
  it("runs a db query inside a transaction on that transaction", async () => {
    await expect(db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO ${sql.raw(TABLE)} (id, note) VALUES (${randomUUID()}, 'written-by-tx')`);
      expect(await notesThroughDb()).toContain("written-by-tx");
      await insertThroughDb("written-by-db");
      throw new Error("roll back");
    })).rejects.toThrow("roll back");
    expect(await committedNotes()).not.toContain("written-by-db");
    expect(await committedNotes()).not.toContain("written-by-tx");
  });

  it("runs a nested transaction as a savepoint whose failed db query rolls back only itself", async () => {
    await db.transaction(async () => {
      await insertThroughDb("savepoint-outer");
      await expect(db.transaction(async () => {
        await insertThroughDb("savepoint-inner");
        await db.execute(sql`SELECT 1 / 0`);
      })).rejects.toThrow();
      await insertThroughDb("savepoint-outer-after");
    });
    const committed = await committedNotes();
    expect(committed).toContain("savepoint-outer");
    expect(committed).toContain("savepoint-outer-after");
    expect(committed).not.toContain("savepoint-inner");
  });

  it("rolls back what a nested transaction and its parent wrote through db when the parent fails", async () => {
    await expect(db.transaction(async () => {
      await insertThroughDb("rollback-outer");
      await db.transaction(async () => {
        await insertThroughDb("rollback-inner");
      });
      throw new Error("parent fails");
    })).rejects.toThrow("parent fails");
    const committed = await committedNotes();
    expect(committed).not.toContain("rollback-outer");
    expect(committed).not.toContain("rollback-inner");
  });

  it("sends work that outlives its transaction to the pool", async () => {
    let later: Promise<string> | undefined;
    await db.transaction(async () => {
      later = new Promise((resolve) => setTimeout(resolve, 50))
        .then(() => db.transaction(() => insertThroughDb("after-commit")));
    });
    await later;
    expect(await committedNotes()).toContain("after-commit");
  });

  it("keeps work that outlives a nested transaction on the parent that is still open", async () => {
    let seen: string[] = [];
    await expect(db.transaction(async () => {
      await insertThroughDb("escape-outer");
      let later: Promise<void> | undefined;
      await db.transaction(async () => {
        later = new Promise((resolve) => setTimeout(resolve, 50)).then(async () => {
          seen = await notesThroughDb();
          await insertThroughDb("escape-late");
        });
      });
      await later;
      throw new Error("parent fails");
    })).rejects.toThrow("parent fails");
    expect(seen).toContain("escape-outer");
    expect(await committedNotes()).not.toContain("escape-late");
  });

  // Last: before the fix this leaves the pool deadlocked for the rest of the file.
  it("opens twice as many uploads at once as the pool has connections", async () => {
    const project = await seedActivityProject(probe);
    const count = env.DB_POOL_SIZE * 2;
    const opened = await within(Promise.all(Array.from({ length: count }, (_, i) => openUpload({
      projectId: project.projectId,
      actingUserId: project.userId,
      declaredSize: 100,
      taskType: "upload",
      ext: ".jpg",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      context: { filename: `pool-${i}.jpg` },
    }, { budgetMs: 60_000, action: "upload", label: `pool-${i}.jpg` }))), 15_000);
    expect(new Set(opened.map((upload) => upload.key)).size).toBe(count);
  });
});
