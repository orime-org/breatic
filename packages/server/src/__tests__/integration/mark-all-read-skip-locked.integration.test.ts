// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * "Mark all read" never waits on a notification row another transaction holds
 * — real Postgres.
 *
 * Several transactions retire more than one bell entry across separate
 * statements (archiving a project, re-addressing requests when an owner
 * changes), so they lock notification rows in no fixed order. A bulk update
 * that waits on one row while holding another can close a cycle with any of
 * them, and Postgres breaks that with 40P01. Here another connection holds one
 * of the user's unread rows: mark-all-read has to come back without waiting,
 * having marked every other row and left the held one to its holder.
 */

import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import postgres from "postgres";
import { initCore } from "@breatic/core";
import * as notificationRepo from "@server/modules/notification/notification.repo.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

/** Longer than an unblocked update takes, far shorter than any lock wait. */
const NO_WAIT_MS = 3_000;

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 3,
    prepare: false,
    connection: { application_name: "mark-all-read-skip-locked-test" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/**
 * Insert a user.
 * @returns The new user's id.
 */
async function insertUser(): Promise<string> {
  const email = `mark-all-read-${Date.now()}-${seq++}@example.test`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${email}, true) RETURNING id
  `;
  return rows[0]!.id;
}

/**
 * Give a user one unread informational notification.
 * @param userId - Its recipient.
 * @returns The notification id.
 */
async function insertUnread(userId: string): Promise<string> {
  const created = await notificationRepo.create({
    userId,
    type: "studio.invite_accepted",
    payload: { studioName: "Acme", inviteeName: "Al" },
  });
  return created.id;
}

/**
 * Whether a notification is still unread.
 * @param id - The notification id.
 * @returns True while `read_at` is null.
 */
async function isUnread(id: string): Promise<boolean> {
  const rows = await sql<{ unread: boolean }[]>`
    SELECT read_at IS NULL AS unread FROM notifications WHERE id = ${id}
  `;
  return rows[0]!.unread;
}

describe("markAllRead", () => {
  it("marks every row it can lock and skips one another transaction holds", async () => {
    const user = await insertUser();
    const held = await insertUnread(user);
    const others = [await insertUnread(user), await insertUnread(user)];

    const holder = await sql.reserve();
    try {
      await holder`BEGIN`;
      await holder`SELECT id FROM notifications WHERE id = ${held} FOR UPDATE`;

      const marked = notificationRepo.markAllRead(user);
      const outcome = await Promise.race([
        marked.then((count) => ({ count })),
        new Promise<"waited">((resolve) => setTimeout(() => resolve("waited"), NO_WAIT_MS)),
      ]);

      expect(outcome).toEqual({ count: others.length });
      for (const id of others) expect(await isUnread(id)).toBe(false);
      expect(await isUnread(held)).toBe(true);
    } finally {
      await holder`ROLLBACK`;
      holder.release();
    }
  });

  it("leaves a request the user still has to answer unread", async () => {
    const user = await insertUser();
    const news = await insertUnread(user);
    const waiting = await notificationRepo.create({
      userId: user,
      type: "project.join_request",
      payload: { shareToken: "tok" },
      expiresAt: new Date(Date.now() + 24 * 3600_000),
    });

    expect(await notificationRepo.markAllRead(user)).toBe(1);
    expect(await isUnread(news)).toBe(false);
    expect(await isUnread(waiting.id)).toBe(true);
  });

  it("marks exactly the rows the unread count counts as news, leaving expired requests out", async () => {
    const user = await insertUser();
    const expired = await notificationRepo.create({
      userId: user,
      type: "studio.transfer_request",
      payload: { shareToken: "tok" },
      expiresAt: new Date(Date.now() - 60_000),
    });

    expect(await notificationRepo.countUnread(user)).toBe(0);
    expect(await notificationRepo.markAllRead(user)).toBe(0);
    expect(await isUnread(expired.id)).toBe(true);
  });

  it("marks all of a user's unread rows and leaves another user's alone", async () => {
    const user = await insertUser();
    const stranger = await insertUser();
    const mine = [await insertUnread(user), await insertUnread(user)];
    const theirs = await insertUnread(stranger);

    expect(await notificationRepo.markAllRead(user)).toBe(mine.length);
    for (const id of mine) expect(await isUnread(id)).toBe(false);
    expect(await isUnread(theirs)).toBe(true);
  });
});
