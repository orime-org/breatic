// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Integration test: the HTTP status a person's client actually receives when
 * they answer a request whose decision window has closed.
 *
 * The services are covered elsewhere; this pins the wire. Both decision
 * endpoints gained a 409 in this change, and neither had a route-level test —
 * a later refactor could drop the guard from the dispatch path and every
 * service test would stay green.
 *
 * Both directions are asserted for each endpoint, because expiry closes a
 * request to BOTH answers: a late "yes" and a late "no" must fail alike, and
 * neither may leave a side effect behind.
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
import type { Hono } from "hono";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

const PG_DRIVER_LOCAL = "decision-window-routes-test-driver";

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: PG_DRIVER_LOCAL },
  });
  // Imported after initCore: `@server/app.js` pulls cors.ts, which reads
  // `env.ALLOWED_ORIGINS` at module-load time.
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/** Insert a fresh registered user; returns its id.
 * @returns The new user's id.
 */
async function insertUser(): Promise<string> {
  const email = `dwr-${seq++}@example.com`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${email}, true) RETURNING id
  `;
  return rows[0]!.id;
}

/**
 * Mint a real Redis session and return the `Cookie` header for it.
 * @param userId - The user to authenticate as.
 * @returns The `Cookie` header value `requireAuth` accepts.
 */
async function loginCookie(userId: string): Promise<string> {
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return `${sessionCookieName()}=${token}`;
}

/**
 * A team studio with `admin` as its admin and `member` as a maintainer.
 * @returns The studio id and slug plus both user ids.
 */
async function seedStudio(): Promise<{
  studioId: string;
  adminId: string;
  memberId: string;
}> {
  const adminId = await insertUser();
  const memberId = await insertUser();
  const slug = `dwr-studio-${seq++}`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${adminId}, ${slug}, 'team', 'Decision Window Routes')
    RETURNING id
  `;
  const studioId = rows[0]!.id;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studioId}, ${adminId}, 'admin'), (${studioId}, ${memberId}, 'maintainer')
  `;
  return { studioId, adminId, memberId };
}

/**
 * An owner, a viewer, and a project the two share.
 * @returns The project id plus both user ids.
 */
async function seedProject(): Promise<{
  projectId: string;
  ownerId: string;
  viewerId: string;
}> {
  const ownerId = await insertUser();
  const viewerId = await insertUser();
  const studioRows = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${ownerId}, ${`dwr-pstudio-${seq++}`}, 'team', 'Decision Window Routes')
    RETURNING id
  `;
  const projectRows = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug, visibility)
    VALUES (${studioRows[0]!.id}, ${ownerId}, 'Demo', ${`dwr-proj-${seq++}`}, 'private')
    RETURNING id
  `;
  const projectId = projectRows[0]!.id;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${projectId}, ${ownerId}, 'owner', NULL),
           (${projectId}, ${viewerId}, 'viewer', ${ownerId})
  `;
  return { projectId, ownerId, viewerId };
}

/**
 * Insert an actionable notification whose deadline has already passed.
 *
 * `projectId` goes in the COLUMN, not only the payload: the role-upgrade
 * decision route resolves the project from `notifications.project_id` before it
 * ever reaches the service, and a null there is a 404 that would mask the 409
 * these tests are here to pin.
 * @param userId - Whose inbox it lands in.
 * @param type - The notification type.
 * @param payload - The type-specific payload (flat, as all three actionable
 *   kinds are).
 * @param projectId - The project scope, for the types that carry one.
 * @returns The new notification's id.
 */
async function insertExpiredNotification(
  userId: string,
  type: string,
  payload: Record<string, string | null>,
  projectId: string | null = null,
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO notifications (user_id, type, payload, project_id, expires_at)
    VALUES (
      ${userId}, ${type}, ${sql.json(payload)}, ${projectId},
      now() - interval '1 hour'
    )
    RETURNING id
  `;
  return rows[0]!.id;
}

/**
 * Read a notification's `read_at`.
 * @param id - The notification id.
 * @returns The timestamp, or null when still unread.
 */
async function readAt(id: string): Promise<Date | null> {
  const rows = await sql<{ read_at: Date | null }[]>`
    SELECT read_at FROM notifications WHERE id = ${id}
  `;
  return rows[0]?.read_at ?? null;
}

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

describe("POST /users/me/notifications/:id/action — expired studio transfer", () => {
  it("409s on confirm and leaves the request unread", async () => {
    const { studioId, adminId, memberId } = await seedStudio();
    const id = await insertExpiredNotification(memberId, "studio.transfer_request", {
      fromUserId: adminId,
      fromName: "Admin",
      studioId,
      studioName: "Decision Window Routes",
    });

    const res = await app.request(`/api/v1/users/me/notifications/${id}/action`, {
      method: "POST",
      headers: { ...JSON_HEADERS, Cookie: await loginCookie(memberId) },
      body: JSON.stringify({ action: "confirm" }),
    });

    expect(res.status).toBe(409);
    expect(await readAt(id)).toBeNull();
  });

  it("409s on cancel too — a late no fails like a late yes", async () => {
    const { studioId, adminId, memberId } = await seedStudio();
    const id = await insertExpiredNotification(memberId, "studio.transfer_request", {
      fromUserId: adminId,
      fromName: "Admin",
      studioId,
      studioName: "Decision Window Routes",
    });

    const res = await app.request(`/api/v1/users/me/notifications/${id}/action`, {
      method: "POST",
      headers: { ...JSON_HEADERS, Cookie: await loginCookie(memberId) },
      body: JSON.stringify({ action: "cancel" }),
    });

    expect(res.status).toBe(409);
    // The mark-read that serializes the decision rolled back with it.
    expect(await readAt(id)).toBeNull();
  });
});

describe("PATCH /role-upgrade-requests/:id/decision — expired request", () => {
  it("409s on approve and does not move the requester's role", async () => {
    const { projectId, ownerId, viewerId } = await seedProject();
    const id = await insertExpiredNotification(ownerId, "access.role_upgrade_request", {
      requesterUserId: viewerId,
      requesterName: "Viewer",
      projectId,
      projectName: "Demo",
      requestedRole: "editor",
      message: null,
    }, projectId);

    const res = await app.request(`/api/v1/role-upgrade-requests/${id}/decision`, {
      method: "PATCH",
      headers: { ...JSON_HEADERS, Cookie: await loginCookie(ownerId) },
      body: JSON.stringify({ decision: "approved" }),
    });

    expect(res.status).toBe(409);
    const rows = await sql<{ role: string }[]>`
      SELECT role FROM project_members
      WHERE project_id = ${projectId} AND user_id = ${viewerId} AND deleted_at IS NULL
    `;
    expect(rows[0]?.role).toBe("viewer");
    expect(await readAt(id)).toBeNull();
  });

  it("409s on reject too — expiry leaves no answer available", async () => {
    const { projectId, ownerId, viewerId } = await seedProject();
    const id = await insertExpiredNotification(ownerId, "access.role_upgrade_request", {
      requesterUserId: viewerId,
      requesterName: "Viewer",
      projectId,
      projectName: "Demo",
      requestedRole: "editor",
      message: null,
    }, projectId);

    const res = await app.request(`/api/v1/role-upgrade-requests/${id}/decision`, {
      method: "PATCH",
      headers: { ...JSON_HEADERS, Cookie: await loginCookie(ownerId) },
      body: JSON.stringify({ decision: "rejected", reason: "too late" }),
    });

    expect(res.status).toBe(409);
    expect(await readAt(id)).toBeNull();
  });
});
