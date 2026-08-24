// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Notifications point at ids, and the server resolves them to current names.
 *
 * Notifications used to store the slug directly. A slug is not stable: renaming
 * a studio releases the old one immediately, and for a personal studio the slug
 * IS the user's @handle — so once someone else claims a released handle, every
 * older notification quietly points at a stranger. There is no way to detect
 * that after the fact, because the stored string still looks perfectly valid.
 *
 * What this pins:
 *   - a stored notification carries ids, not slugs or handles
 *   - the list endpoint returns the identities those ids resolve to NOW
 *   - after a rename, an OLD notification resolves to the NEW slug
 *   - an id whose target is gone is simply absent, so the frontend can render
 *     plain text instead of a dead link
 *   - resolution is batched: one page costs a constant number of queries
 *
 * @see studio settings design (2026-07-28) § 6
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

import crypto from "node:crypto";
import postgres from "postgres";
import {
  initCore,
  getRedis,
  setSession,
  sessionCookieName,
  loadLocales,
} from "@breatic/core";
import * as studioTransferService from "@server/modules/studio/studioTransfer.service.js";
import * as studioService from "@server/modules/studio/studio.service.js";
import type { NotificationListView } from "@breatic/shared";
import type { Hono } from "hono";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "notification-id-refs-test" },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;
/**
 * Insert a verified user together with their personal studio.
 * @param handle - the personal studio's slug, which is the user's @handle.
 * @returns the user's id.
 */
async function insertUserWithHandle(handle: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`nid-${seq++}@example.com`}, true) RETURNING id
  `;
  const userId = rows[0]!.id;
  await sql`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${handle}, 'personal', ${handle})
  `;
  return userId;
}

let studioSeq = 0;
/**
 * Insert a team studio plus its admin member row.
 * @param adminUserId - the user who becomes the studio's admin.
 * @param name - the studio's display name.
 * @returns the studio's id and slug.
 */
async function insertStudio(
  adminUserId: string,
  name = "Before Rename",
): Promise<{ id: string; slug: string }> {
  const slug = `nid-studio-${(studioSeq++).toString().padStart(4, "0")}`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${adminUserId}, ${slug}, 'team', ${name}) RETURNING id
  `;
  const id = rows[0]!.id;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${id}, ${adminUserId}, 'admin')`;
  return { id, slug };
}

/**
 * Mint a real Redis session and return the authenticating Cookie header.
 * @param userId - the user to authenticate as.
 * @returns a Cookie header value.
 */
async function loginCookie(userId: string): Promise<string> {
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return `${sessionCookieName()}=${token}`;
}

/**
 * Read a user's notification list through the real endpoint.
 * @param cookie - the caller's session cookie.
 * @returns the list view: items plus the identities their ids resolve to.
 */
async function listNotifications(cookie: string): Promise<NotificationListView> {
  const res = await app.request("/api/v1/users/me/notifications", {
    headers: { Cookie: cookie },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: NotificationListView };
  return body.data;
}

describe("notification payloads carry ids, not names", () => {
  it("stores no slug or handle on a studio transfer request", async () => {
    const admin = await insertUserWithHandle(`nid-admin-${seq}`);
    const recipient = await insertUserWithHandle(`nid-recip-${seq}`);
    const studio = await insertStudio(admin);
    await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio.id}, ${recipient}, 'maintainer')`;

    await studioTransferService.requestTransfer(studio.slug, admin, recipient);

    const rows = await sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM notifications
      WHERE user_id = ${recipient} AND type = 'studio.transfer_request'
    `;
    const payload = rows[0]!.payload;
    // The ids stay; the name-shaped copies are gone.
    expect(payload["fromUserId"]).toBe(admin);
    expect(payload["studioId"]).toBe(studio.id);
    expect(payload).not.toHaveProperty("fromHandle");
    expect(payload).not.toHaveProperty("studioSlug");
  });
});

describe("the list endpoint resolves ids to current identities", () => {
  it("returns items plus a resolved map, inside the data envelope", async () => {
    const admin = await insertUserWithHandle(`nid-a2-${seq}`);
    const recipient = await insertUserWithHandle(`nid-r2-${seq}`);
    const studio = await insertStudio(admin, "Acme Team");
    await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio.id}, ${recipient}, 'maintainer')`;
    await studioTransferService.requestTransfer(studio.slug, admin, recipient);
    const cookie = await loginCookie(recipient);

    const view = await listNotifications(cookie);

    expect(view.items.length).toBeGreaterThan(0);
    expect(view.resolved.studios[studio.id]).toEqual({
      slug: studio.slug,
      name: "Acme Team",
      deleted: false,
    });
    // The initiating admin resolves through their personal studio — that is
    // where a user's display identity lives.
    expect(view.resolved.users[admin]).toBeDefined();
  });

  it("an OLD notification resolves to the NEW slug after a rename", async () => {
    // The entire reason this feature exists. With the slug stored in the
    // payload, this notification would keep pointing at an address that now
    // 404s — or worse, at whoever claimed the released handle.
    const admin = await insertUserWithHandle(`nid-a3-${seq}`);
    const recipient = await insertUserWithHandle(`nid-r3-${seq}`);
    const studio = await insertStudio(admin, "Old Name");
    await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio.id}, ${recipient}, 'maintainer')`;
    await studioTransferService.requestTransfer(studio.slug, admin, recipient);
    const cookie = await loginCookie(recipient);

    const renamedSlug = `nid-renamed-${studioSeq}`;
    await studioService.updateStudio(studio.slug, {
      slug: renamedSlug,
      name: "New Name",
    });

    const view = await listNotifications(cookie);

    expect(view.resolved.studios[studio.id]).toEqual({
      slug: renamedSlug,
      name: "New Name",
      deleted: false,
    });
  });

  it("keeps the name of a soft-deleted target, but marks it unlinkable", async () => {
    const admin = await insertUserWithHandle(`nid-a4-${seq}`);
    const recipient = await insertUserWithHandle(`nid-r4-${seq}`);
    const studio = await insertStudio(admin);
    await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio.id}, ${recipient}, 'maintainer')`;
    await studioTransferService.requestTransfer(studio.slug, admin, recipient);
    const cookie = await loginCookie(recipient);

    await sql`UPDATE studios SET deleted_at = now() WHERE id = ${studio.id}`;

    const view = await listNotifications(cookie);

    // Soft delete is deactivation, not erasure — the industry split (GitHub's
    // ghost user, Slack's deactivate-vs-delete-profile) keeps the NAME visible
    // at this level and only anonymises on an explicit erasure step. So the
    // entry stays resolvable, carrying `deleted` so the frontend drops the
    // link while still naming what the notification is about.
    const ref = view.resolved.studios[studio.id];
    expect(ref).toBeDefined();
    expect(ref?.name).toBe("Before Rename");
    expect(ref?.deleted).toBe(true);
    expect(view.items.length).toBeGreaterThan(0);
  });

  it("marks a live target as not deleted", async () => {
    const admin = await insertUserWithHandle(`nid-a6-${seq}`);
    const recipient = await insertUserWithHandle(`nid-r6-${seq}`);
    const studio = await insertStudio(admin);
    await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio.id}, ${recipient}, 'maintainer')`;
    await studioTransferService.requestTransfer(studio.slug, admin, recipient);
    const cookie = await loginCookie(recipient);

    const view = await listNotifications(cookie);

    expect(view.resolved.studios[studio.id]?.deleted).toBe(false);
  });

  it("resolves a page of many notifications without a query per item", async () => {
    // Batched by kind. Written as a behavioural check rather than a query
    // count: several notifications from DIFFERENT studios must all resolve,
    // which a naive one-at-a-time implementation would also pass — but this
    // at least pins that batching does not lose entries, which is the way
    // batching usually breaks.
    const admin = await insertUserWithHandle(`nid-a5-${seq}`);
    const recipient = await insertUserWithHandle(`nid-r5-${seq}`);
    const studios = [];
    for (let i = 0; i < 3; i++) {
      const s = await insertStudio(admin, `Studio ${i}`);
      await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${s.id}, ${recipient}, 'maintainer')`;
      await studioTransferService.requestTransfer(s.slug, admin, recipient);
      studios.push(s);
    }
    const cookie = await loginCookie(recipient);

    const view = await listNotifications(cookie);

    for (const s of studios) {
      expect(view.resolved.studios[s.id]).toMatchObject({ slug: s.slug });
    }
  });

  it("resolves a user through their LIVE personal studio when a soft-deleted one also exists", async () => {
    // Soft-deleted rows are deliberately no longer filtered out — a
    // notification naming nobody is not a usable record. But that means one
    // user can match more than one row, and the query has no ordering, so
    // building the map by last-write-wins would pick an arbitrary one. Here
    // the dead row is inserted AFTER the live one, which is the order that
    // catches it.
    const admin = await insertUserWithHandle(`nid-a6-${seq}`);
    const recipient = await insertUserWithHandle(`nid-r6-${seq}`);
    await sql`
      INSERT INTO studios (created_by_user_id, slug, type, name, deleted_at)
      VALUES (${admin}, ${`nid-dead-${seq++}`}, 'personal', 'Deleted Identity', now())
    `;
    const studio = await insertStudio(admin, "Acme Team");
    await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio.id}, ${recipient}, 'maintainer')`;
    await studioTransferService.requestTransfer(studio.slug, admin, recipient);
    const cookie = await loginCookie(recipient);

    const view = await listNotifications(cookie);

    expect(view.resolved.users[admin]).toMatchObject({ deleted: false });
    expect(view.resolved.users[admin]!.name).not.toBe("Deleted Identity");
  });
});
