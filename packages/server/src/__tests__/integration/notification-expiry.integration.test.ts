// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Notification studio types + expiry filter (slice 3) — the `notifications`
 * table gains an `expires_at` column and the studio notification types
 * (`studio.transfer_request` / `studio.transfer_approved` / `studio.invite_*`),
 * against a real Postgres. SQL-level facts:
 *
 *   - the type CHECK constraint accepts the new studio.* types;
 *   - `create` persists `expires_at`;
 *   - `listUnreadByUser` hides a notification whose `expires_at` is in the
 *     past (an unconfirmed transfer that timed out), while a future or null
 *     `expires_at` stays visible.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

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

import postgres from "postgres";
import { initCore } from "@breatic/core";
import * as notificationRepo from "@server/modules/notification/notification.repo.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "notification-expiry-test" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;
async function insertUser(): Promise<string> {
  const email = `notif-${seq++}@example.com`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${email}, true) RETURNING id
  `;
  return rows[0]!.id;
}

describe("notifications — studio types + expiry filter", () => {
  it("accepts an informational studio type (notifications_type CHECK)", async () => {
    const user = await insertUser();
    const n = await notificationRepo.create({
      userId: user,
      type: "studio.invite_accepted",
      payload: { studioName: "Acme", inviteeName: "Al" },
    });
    expect(n.type).toBe("studio.invite_accepted");
    const list = await notificationRepo.listUnreadByUser(user);
    expect(list.map((x) => x.id)).toContain(n.id);
  });

  it("persists expiresAt and hides an EXPIRED notification while future/null stay", async () => {
    const user = await insertUser();
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 7 * 24 * 3600_000);

    const expired = await notificationRepo.create({
      userId: user,
      type: "studio.transfer_request",
      payload: { fromUserId: "00000000-0000-0000-0000-000000000000", studioName: "Acme" },
      expiresAt: past,
    });
    const pending = await notificationRepo.create({
      userId: user,
      type: "studio.transfer_request",
      payload: { fromUserId: "00000000-0000-0000-0000-000000000000", studioName: "Acme" },
      expiresAt: future,
    });
    const evergreen = await notificationRepo.create({
      userId: user,
      type: "studio.invite_accepted",
      payload: { studioName: "Acme", inviteeName: "Al" },
    });

    expect(pending.expiresAt).not.toBeNull(); // persisted
    expect(evergreen.expiresAt).toBeNull(); // no TTL for an informational notice

    const ids = (await notificationRepo.listUnreadByUser(user)).map((x) => x.id);
    expect(ids).not.toContain(expired.id); // timed out — hidden
    expect(ids).toContain(pending.id); // still actionable
    expect(ids).toContain(evergreen.id); // no expiry
  });

  it("accepts studio.transfer_approved type", async () => {
    const user = await insertUser();
    const n = await notificationRepo.create({
      userId: user,
      type: "studio.transfer_approved",
      payload: { studioName: "Acme" },
    });
    expect(n.type).toBe("studio.transfer_approved");
  });
});
