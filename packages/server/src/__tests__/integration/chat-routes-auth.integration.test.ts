// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The auth boundary in front of chat, driven through the real Hono app.
 *
 * Acceptance items 48-50. This is the first change that has the front end
 * really call `/chat/message`, and it renames fields and moves the URL prefix
 * at the same time — the combination where a guard is easiest to walk past
 * without noticing. Chat is also a creative-write action, so a view-only
 * member must be refused even though they can read everything in the project.
 *
 * Item 49 additionally pins that a refused request leaves NO conversation row
 * behind: the access check has to run before anything is created, or a
 * stranger's rejected request still litters another tenant's project.
 *
 * Auth is real — a Redis session token under the real cookie name, which is
 * what `requireAuth` reads.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// Mock `ai` BEFORE importing @breatic/core / the app (the barrels pull
// agent/llm → the `ai` SDK → @opentelemetry/api, whose ESM build Node's native
// ESM rejects). Every request here is refused before any model is reached.
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

const PG_DRIVER_LOCAL = "chat-routes-auth-test-driver";

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: PG_DRIVER_LOCAL },
  });
  // Import the app AFTER initCore ran (app.js → cors.ts reads env at module
  // load; the dynamic import defers it past initCore above).
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/**
 * Seed an owner with a studio and a project they own.
 * @returns The owner, their studio and their project.
 */
async function seedOwnedProject(): Promise<{
  userId: string;
  studioId: string;
  projectId: string;
}> {
  const tag = `ca-${seq++}`;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`${tag}@example.com`}, true) RETURNING id
  `;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`${tag}-studio`}, 'team', ${tag}) RETURNING id
  `;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${user!.id}, 'admin')
  `;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug, visibility)
    VALUES (${studio!.id}, ${user!.id}, ${tag}, ${`${tag}-p`}, 'private') RETURNING id
  `;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${project!.id}, ${user!.id}, 'owner', null)
  `;
  return { userId: user!.id, studioId: studio!.id, projectId: project!.id };
}

/**
 * Insert a bare registered user with no memberships.
 * @returns The new user's id.
 */
async function insertOutsider(): Promise<string> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`ca-out-${seq++}@example.com`}, true) RETURNING id
  `;
  return user!.id;
}

/**
 * Mint a real Redis session and return the authenticating Cookie header.
 * @param userId - The user to sign in.
 * @returns A `Cookie` header value carrying a live session token.
 */
async function loginCookie(userId: string): Promise<string> {
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return `${sessionCookieName()}=${token}`;
}

/**
 * Count conversation rows attached to a project, deleted ones included.
 * @param projectId - Project to count against.
 * @returns How many conversation rows name that project.
 */
async function conversationCount(projectId: string): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM conversations WHERE project_id = ${projectId}
  `;
  return Number(rows[0]!.n);
}

const body = (projectId: string): string =>
  JSON.stringify({ message: "hello", project_id: projectId });

describe("POST /api/v1/chat/message — who gets in", () => {
  it("refuses an unauthenticated caller with 401", async () => {
    const { projectId } = await seedOwnedProject();

    const res = await app.request("/api/v1/chat/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body(projectId),
    });

    expect(res.status).toBe(401);
  });

  it("hides a project the caller has no part in, and creates nothing", async () => {
    const { projectId } = await seedOwnedProject();
    const outsider = await insertOutsider();
    const before = await conversationCount(projectId);

    const res = await app.request("/api/v1/chat/message", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: await loginCookie(outsider) },
      body: body(projectId),
    });

    // 404, not 403: a non-member is not told the project exists. Same rule the
    // rest of the project routes follow.
    expect(res.status).toBe(404);
    // The check runs before anything is created, so a refused request leaves
    // no row behind in someone else's project.
    expect(await conversationCount(projectId)).toBe(before);
  });

  it("refuses a view-only member with 403, and creates nothing", async () => {
    const { studioId, projectId } = await seedOwnedProject();
    const viewer = await insertOutsider();
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${viewer}, 'guest')
    `;
    await sql`
      INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${projectId}, ${viewer}, 'viewer', null)
    `;
    const before = await conversationCount(projectId);

    const res = await app.request("/api/v1/chat/message", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: await loginCookie(viewer) },
      body: body(projectId),
    });

    // Chat writes into the project, so reading it is not enough.
    expect(res.status).toBe(403);
    expect(await conversationCount(projectId)).toBe(before);
  });

  it("refuses a member demoted after they already had a conversation here", async () => {
    const { studioId, projectId } = await seedOwnedProject();
    const member = await insertOutsider();
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${member}, 'maintainer')
    `;
    await sql`
      INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${projectId}, ${member}, 'editor', null)
    `;
    const cookie = await loginCookie(member);

    // Establishing a conversation is what puts a pointer in place, and the
    // pointer is what makes the SECOND request take a different path through
    // the resolver: it no longer creates anything, so the check the creation
    // path performs never runs. Only the route's own guard covers this path,
    // and access can be taken away between two messages.
    const conversation = await sql<{ id: string }[]>`
      INSERT INTO conversations (user_id, title, project_id)
      VALUES (${member}, 'earlier', ${projectId}) RETURNING id
    `;
    await sql`
      INSERT INTO current_conversations (user_id, project_id, conversation_id)
      VALUES (${member}, ${projectId}, ${conversation[0]!.id})
    `;

    await sql`
      UPDATE project_members SET role = 'viewer'
      WHERE project_id = ${projectId} AND user_id = ${member}
    `;

    const res = await app.request("/api/v1/chat/message", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: body(projectId),
    });

    expect(res.status).toBe(403);

    // And nothing was appended to the conversation they used to own.
    const messages = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM conversation_messages
      WHERE conversation_id = ${conversation[0]!.id}
    `;
    expect(Number(messages[0]!.n)).toBe(0);
  });
});

describe("POST /api/v1/chat/skill — the other way in owes the same guard", () => {
  it("refuses a demoted member invoking a skill", async () => {
    // Two doors lead into a chat turn, and a demoted member walking through
    // the second one costs just as much: a skill invocation appends messages
    // and bills a turn. The resolver returns early once a pointer exists, so
    // its own access check never runs on this path — the route's guard is the
    // only thing standing there, on BOTH entrances.
    const { studioId, projectId } = await seedOwnedProject();
    const member = await insertOutsider();
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${member}, 'maintainer')
    `;
    await sql`
      INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${projectId}, ${member}, 'editor', null)
    `;
    const cookie = await loginCookie(member);

    const conversation = await sql<{ id: string }[]>`
      INSERT INTO conversations (user_id, title, project_id)
      VALUES (${member}, 'earlier', ${projectId}) RETURNING id
    `;
    await sql`
      INSERT INTO current_conversations (user_id, project_id, conversation_id)
      VALUES (${member}, ${projectId}, ${conversation[0]!.id})
    `;

    await sql`
      UPDATE project_members SET role = 'viewer'
      WHERE project_id = ${projectId} AND user_id = ${member}
    `;

    const res = await app.request("/api/v1/chat/skill", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        skill_name: "brainstorm",
        input: "three angles please",
        project_id: projectId,
      }),
    });

    expect(res.status).toBe(403);

    const messages = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM conversation_messages
      WHERE conversation_id = ${conversation[0]!.id}
    `;
    expect(Number(messages[0]!.n)).toBe(0);
  });
});
