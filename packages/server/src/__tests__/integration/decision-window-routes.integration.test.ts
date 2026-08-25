// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Integration test: the HTTP status a person's client actually receives when
 * they answer a request whose decision window has closed.
 *
 * The services are covered elsewhere; this pins the wire. There is one pair of
 * decision endpoints now, and neither had a route-level test of expiry — a
 * later refactor could drop the guard from the dispatch path and every service
 * test would stay green.
 *
 * Both directions are asserted for each flow, because expiry closes a request
 * to BOTH answers: a late "yes" and a late "no" must fail alike, and neither
 * may leave a side effect behind.
 *
 * The two endpoints this file used to drive — `POST /notifications/:id/action`
 * and `PATCH /role-upgrade-requests/:id/decision` — were the second and third
 * doors into a decision, and are gone. What they were guarding moved here,
 * onto the one entrance, where a single assertion covers all five flows
 * instead of one per door.
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

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

/**
 * File a request that is already past its deadline, and hand back its token.
 * @param table - Which request table to write.
 * @param columns - The flow-specific columns.
 * @returns The share token naming the expired request.
 */
async function expiredRequest(
  table: "studio_transfers" | "role_upgrade_requests",
  columns: Record<string, string>,
): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  const names = Object.keys(columns);
  const values = Object.values(columns);
  await sql.unsafe(
    `INSERT INTO ${table} (${names.join(", ")}, status, share_token, expires_at)
     VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")}, 'pending', $${names.length + 1}, now() - interval '1 hour')`,
    [...values, token],
  );
  return token;
}

/**
 * Answer a request through the one endpoint that answers requests.
 * @param token - The request's share token.
 * @param userId - Who is answering.
 * @param action - Which answer.
 * @returns The HTTP response.
 */
async function respond(
  token: string,
  userId: string,
  action: "confirm" | "decline",
): Promise<Response> {
  return app.request("/api/v1/decisions/respond", {
    method: "POST",
    headers: { ...JSON_HEADERS, Cookie: await loginCookie(userId) },
    body: JSON.stringify({ token, action }),
  });
}

describe("answering an expired studio transfer", () => {
  it("409s on confirm, and hands nothing over", async () => {
    const { studioId, adminId, memberId } = await seedStudio();
    const token = await expiredRequest("studio_transfers", {
      studio_id: studioId,
      from_user_id: adminId,
      to_user_id: memberId,
    });

    const res = await respond(token, memberId, "confirm");

    expect(res.status).toBe(409);
    const rows = await sql<{ role: string }[]>`
      SELECT role FROM studio_members
      WHERE studio_id = ${studioId} AND user_id = ${adminId} AND deleted_at IS NULL
    `;
    expect(rows[0]?.role).toBe("admin");
  });

  it("409s on decline too — a late no fails like a late yes", async () => {
    const { studioId, adminId, memberId } = await seedStudio();
    const token = await expiredRequest("studio_transfers", {
      studio_id: studioId,
      from_user_id: adminId,
      to_user_id: memberId,
    });

    const res = await respond(token, memberId, "decline");

    expect(res.status).toBe(409);
  });
});

describe("answering an expired role-upgrade request", () => {
  it("409s on approve and does not move the requester's role", async () => {
    const { projectId, ownerId, viewerId } = await seedProject();
    const token = await expiredRequest("role_upgrade_requests", {
      project_id: projectId,
      requester_user_id: viewerId,
      requested_role: "editor",
    });

    const res = await respond(token, ownerId, "confirm");

    expect(res.status).toBe(409);
    const rows = await sql<{ role: string }[]>`
      SELECT role FROM project_members
      WHERE project_id = ${projectId} AND user_id = ${viewerId} AND deleted_at IS NULL
    `;
    expect(rows[0]?.role).toBe("viewer");
  });

  it("409s on reject too — expiry leaves no answer available", async () => {
    const { projectId, ownerId, viewerId } = await seedProject();
    const token = await expiredRequest("role_upgrade_requests", {
      project_id: projectId,
      requester_user_id: viewerId,
      requested_role: "editor",
    });

    const res = await respond(token, ownerId, "decline");

    expect(res.status).toBe(409);
  });
});
