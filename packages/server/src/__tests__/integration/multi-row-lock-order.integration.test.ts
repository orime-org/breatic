// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every `FOR UPDATE` that can take several rows takes them in key order —
 * real Postgres.
 *
 * Postgres locks rows in the order the plan hands them up. Without an
 * `ORDER BY` that order belongs to the plan: `studio_members` alone has two
 * indexes that satisfy "the active members of this studio", one walking
 * `user_id` order (the primary key) and one walking physical order
 * (`studio_members_studio_id_idx`, whose second column is `deleted_at`). Two
 * transactions that lock the same set through different plans can each hold a
 * row the other wants next, and Postgres breaks that with 40P01.
 *
 * Each case below makes the plan's order the reverse of key order: the rows
 * are inserted largest key first and the locking transaction is forced onto a
 * sequential scan. Another connection holds the smallest-key row, the locker
 * parks, and the probe asks whether the locker already took the largest-key
 * row. Locking in key order means it parks on the first row it wants and holds
 * nothing else.
 */

import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { sql as drizzleSql } from "drizzle-orm";
import { db, initCore, loadLocales, projectMembersRepo, type DbTx } from "@breatic/core";
import { studioMembersRepo } from "@breatic/domain";
import { cascadeDeleteConversations } from "@server/modules/conversation/conversation.repo.js";
import { waitUntilBlockedOn } from "@server/__tests__/integration/lock-probe.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "multi-row-lock-order-test" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/**
 * Three fresh ids, smallest first.
 * @returns The sorted ids.
 */
function sortedIds(): [string, string, string] {
  const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
  return [ids[0]!, ids[1]!, ids[2]!];
}

/**
 * Insert a user with a chosen id.
 * @param id - The user id.
 * @param tag - A unique tag for the email.
 */
async function insertUser(id: string, tag: string): Promise<void> {
  await sql`
    INSERT INTO users (id, email, email_verified, membership_tier)
    VALUES (${id}, ${`${tag}@example.test`}, true, 'pro')
  `;
}

/**
 * Insert a team studio owned by the given user.
 * @param adminId - The creator.
 * @param tag - A unique tag for the slug.
 * @returns The studio id.
 */
async function insertStudio(adminId: string, tag: string): Promise<string> {
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${adminId}, ${`${tag}-s`}, 'team', 'Studio') RETURNING id
  `;
  return studio!.id;
}

/**
 * Run `lock` inside a transaction forced onto sequential scans while another
 * connection holds `holdSmallest`, and report whether `probeLargest` was
 * already locked by the time the locker parked.
 * @param holdSmallest - Locks the smallest-key row on the holder connection.
 * @param probeLargest - `SELECT … FOR UPDATE NOWAIT` on the largest-key row.
 * @param lock - The production lock under test.
 * @param parkedOn - Substrings of the statement the locker parks on.
 * @returns Whether the largest-key row was held while the locker waited.
 */
async function largestHeldWhileParked(
  holdSmallest: (h: postgres.TransactionSql) => Promise<unknown>,
  probeLargest: (p: postgres.TransactionSql) => Promise<unknown>,
  lock: (tx: DbTx) => Promise<unknown>,
  parkedOn: readonly string[],
): Promise<boolean> {
  const holder = postgres(inject("DATABASE_URL"), { max: 1, prepare: false });
  let locker: Promise<unknown> = Promise.resolve();
  let held = false;
  try {
    await holder.begin(async (h) => {
      await holdSmallest(h);
      locker = db.transaction(async (tx) => {
        await tx.execute(drizzleSql`SET LOCAL enable_indexscan = off`);
        await tx.execute(drizzleSql`SET LOCAL enable_bitmapscan = off`);
        await lock(tx);
      });
      await waitUntilBlockedOn(sql, parkedOn, 1);
      held = await rowIsLocked(probeLargest);
    });
  } finally {
    await locker;
    await holder.end({ timeout: 5 });
  }
  return held;
}

/**
 * Whether another transaction holds the row the probe asks for.
 * @param probe - A `FOR UPDATE NOWAIT` select on one row.
 * @returns True when the row is already locked.
 */
async function rowIsLocked(
  probe: (p: postgres.TransactionSql) => Promise<unknown>,
): Promise<boolean> {
  const conn = postgres(inject("DATABASE_URL"), { max: 1, prepare: false });
  try {
    await conn.begin(async (p) => {
      await probe(p);
    });
    return false;
  } catch (err) {
    // 55P03 is "lock_not_available", which NOWAIT raises instead of waiting.
    if ((err as { code?: string }).code === "55P03") return true;
    throw err;
  } finally {
    await conn.end({ timeout: 5 });
  }
}

describe("multi-row FOR UPDATE — locks are taken in key order", () => {
  it("lockMembership takes a studio's member rows in user_id order", async () => {
    const tag = `mrlo-${seq++}`;
    const [u1, u2, u3] = sortedIds();
    for (const [i, id] of [u3, u2, u1].entries()) await insertUser(id, `${tag}-${i}`);
    const studioId = await insertStudio(u3, tag);
    await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${u3}, 'admin')`;
    await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${u2}, 'maintainer')`;
    await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${u1}, 'guest')`;
    const scan = await sql<{ user_id: string }[]>`
      SELECT user_id FROM studio_members WHERE studio_id = ${studioId} ORDER BY ctid
    `;
    expect(scan.map((r) => r.user_id)).toEqual([u3, u2, u1]);

    const held = await largestHeldWhileParked(
      (h) => h`SELECT 1 FROM studio_members WHERE studio_id = ${studioId} AND user_id = ${u1} FOR UPDATE`,
      (p) => p`SELECT 1 FROM studio_members WHERE studio_id = ${studioId} AND user_id = ${u3} FOR UPDATE NOWAIT`,
      (tx) => studioMembersRepo.lockMembership(studioId, tx),
      ["studio_members", "for update"],
    );
    expect(held).toBe(false);
  });

  it("lockOwnedProjectsInStudio takes the owner's project_members rows in project_id order", async () => {
    const tag = `mrlo-${seq++}`;
    const ownerId = randomUUID();
    await insertUser(ownerId, `${tag}-o`);
    const studioId = await insertStudio(ownerId, tag);
    const [p1, p2, p3] = sortedIds();
    // Both sides of the join land largest key first, so whichever side the
    // plan drives from, it meets the largest key first.
    for (const id of [p3, p2, p1]) {
      await sql`
        INSERT INTO projects (id, studio_id, created_by_user_id, name, slug)
        VALUES (${id}, ${studioId}, ${ownerId}, 'Project', ${`${tag}-${id.slice(0, 8)}`})
      `;
    }
    for (const id of [p3, p2, p1]) {
      await sql`INSERT INTO project_members (project_id, user_id, role) VALUES (${id}, ${ownerId}, 'owner')`;
    }
    const scan = await sql<{ project_id: string }[]>`
      SELECT project_id FROM project_members WHERE user_id = ${ownerId} ORDER BY ctid
    `;
    expect(scan.map((r) => r.project_id)).toEqual([p3, p2, p1]);
    const projectScan = await sql<{ id: string }[]>`
      SELECT id FROM projects WHERE studio_id = ${studioId} ORDER BY ctid
    `;
    expect(projectScan.map((r) => r.id)).toEqual([p3, p2, p1]);

    const held = await largestHeldWhileParked(
      (h) => h`SELECT 1 FROM project_members WHERE project_id = ${p1} AND user_id = ${ownerId} FOR UPDATE`,
      (p) => p`SELECT 1 FROM project_members WHERE project_id = ${p3} AND user_id = ${ownerId} FOR UPDATE NOWAIT`,
      (tx) => projectMembersRepo.lockOwnedProjectsInStudio(studioId, ownerId, tx),
      ["project_members", "for update"],
    );
    expect(held).toBe(false);
  });

  it("cascadeDeleteConversations takes the conversation rows in id order", async () => {
    const tag = `mrlo-${seq++}`;
    const userId = randomUUID();
    await insertUser(userId, `${tag}-u`);
    const [c1, c2, c3] = sortedIds();
    for (const id of [c3, c2, c1]) {
      await sql`INSERT INTO conversations (id, user_id, title) VALUES (${id}, ${userId}, 'seeded')`;
    }
    const scan = await sql<{ id: string }[]>`
      SELECT id FROM conversations WHERE user_id = ${userId} ORDER BY ctid
    `;
    expect(scan.map((r) => r.id)).toEqual([c3, c2, c1]);

    const held = await largestHeldWhileParked(
      (h) => h`SELECT 1 FROM conversations WHERE id = ${c1} FOR UPDATE`,
      (p) => p`SELECT 1 FROM conversations WHERE id = ${c3} FOR UPDATE NOWAIT`,
      (tx) => cascadeDeleteConversations(tx, [c3, c2, c1]),
      ["conversations", "for update"],
    );
    expect(held).toBe(false);
  });
});
