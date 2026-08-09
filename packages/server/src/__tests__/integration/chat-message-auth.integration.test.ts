// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The auth boundary in front of `/chat/message`, driven through the real app.
 *
 * Acceptance items 48, 49 and 50. Chat is a creative-write action, so being
 * able to read a project is not enough to say something in it, and a project
 * the caller has no part in must not even be admitted to exist.
 *
 * Every request here carries a well-formed body, conversation id included.
 * That is the point: the id is required now, so a malformed request stops at
 * the validator and never reaches a guard — a suite built out of those would
 * report a boundary it never touched. The suite this replaces was exactly that
 * shape, which is why it went when the design it was written against did.
 *
 * Three of the five witness the project guard, and two do not — measured, with
 * `projectService.assertAccess` removed from the route:
 *
 * - signed out: the session middleware refuses it first, either way
 * - a stranger's project_id: STILL GREEN. The conversation they send lives in
 *   their own project, so the id check refuses them on its own
 * - removed member, view-only member, demoted member: all three red. Each holds
 *   an id that is theirs, in this project, and not deleted, so every id check
 *   passes and only the project guard is left to turn them away
 *
 * So the stranger case is the weakest of the five, kept because item 49 words
 * it that way, and the three that follow it are what actually hold the guard in
 * place. Deleting them as duplicates would leave nothing pinning it.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// `ai` is stubbed so this suite needs no API key and reaches no network.
// `llm.ts` falls back to OpenRouter whenever no direct provider key is set,
// so a suite that does call a model would otherwise issue a real request
// from CI.
vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
    totalUsage: Promise.resolve({ totalTokens: 0 }),
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

const PG_DRIVER_LOCAL = "chat-message-auth-test-driver";

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

/** A signed-in owner with a studio, a project, and a conversation in it. */
interface Seeded {
  userId: string;
  studioId: string;
  projectId: string;
  cookie: string;
  conversationId: string;
}

/**
 * Give a user a session and the cookie that carries it.
 * @param userId - User to sign in.
 * @returns A Cookie header value `requireAuth` accepts.
 */
async function loginCookie(userId: string): Promise<string> {
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return `${sessionCookieName()}=${token}`;
}

/**
 * Insert a user with no membership anywhere.
 * @returns The new user's id.
 */
async function insertUser(): Promise<string> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`msg-auth-${seq++}@example.com`}, true) RETURNING id
  `;
  return user!.id;
}

/**
 * Seed an owner with a project, signed in, holding a conversation there.
 * @returns The owner, their studio, project, cookie and conversation.
 */
async function seedOwner(): Promise<Seeded> {
  const tag = `msg-auth-${seq++}`;
  const userId = await insertUser();
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`${tag}-studio`}, 'team', ${tag}) RETURNING id
  `;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${userId}, 'admin')
  `;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug, visibility)
    VALUES (${studio!.id}, ${userId}, ${tag}, ${`${tag}-p`}, 'private') RETURNING id
  `;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${project!.id}, ${userId}, 'owner', null)
  `;
  const cookie = await loginCookie(userId);
  const [conversation] = await sql<{ id: string }[]>`
    INSERT INTO conversations (user_id, title, project_id)
    VALUES (${userId}, 'seeded', ${project!.id}) RETURNING id
  `;
  return {
    userId,
    studioId: studio!.id,
    projectId: project!.id,
    cookie,
    conversationId: conversation!.id,
  };
}

/**
 * Post a chat message, optionally without a session.
 * @param body - Request body, complete unless a case says otherwise.
 * @param cookie - Session cookie, or undefined to arrive signed out.
 * @returns The raw response.
 */
async function send(
  body: Record<string, unknown>,
  cookie?: string,
): Promise<Response> {
  return app.request("/api/v1/chat/message", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

/**
 * Count the conversations living in a project, deleted ones included.
 * @param projectId - Project to count in.
 * @returns The row count.
 */
async function conversationCount(projectId: string): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM conversations WHERE project_id = ${projectId}
  `;
  return Number(rows[0]!.n);
}

/**
 * Count the messages written into a conversation.
 * @param conversationId - Conversation to count in.
 * @returns The row count.
 */
async function messageCount(conversationId: string): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM conversation_messages
    WHERE conversation_id = ${conversationId}
  `;
  return Number(rows[0]!.n);
}

describe("POST /chat/message — who may say something", () => {
  it("refuses an unauthenticated caller", async () => {
    // Item 48. 401, not 404: a protected route says "identify yourself",
    // and 404 is reserved for a route that does not exist at all.
    const { projectId, conversationId } = await seedOwner();

    const res = await send({
      message: "hello",
      project_id: projectId,
      conversation_id: conversationId,
    });

    expect(res.status).toBe(401);
    expect(await messageCount(conversationId)).toBe(0);
  });

  it("hides a project the caller has no part in, and writes nothing", async () => {
    // Item 49, worded the way the item words it: user A sends user B's
    // project_id. What matters is the answer — 404, not 403, because telling
    // an outsider "you may not" would confirm the project exists.
    //
    // Both guards refuse this one: the conversation the stranger sends lives
    // in their own project, so the id check turns them away whether or not the
    // project guard is there. Measured — with the guard removed this case
    // stays green. The case below is the one that pins it.
    const stranger = await seedOwner();
    const target = await seedOwner();
    const before = await conversationCount(target.projectId);

    const res = await send(
      {
        message: "into a project I am not in",
        project_id: target.projectId,
        conversation_id: stranger.conversationId,
      },
      stranger.cookie,
    );

    expect(res.status).toBe(404);
    expect(await conversationCount(target.projectId)).toBe(before);
    expect(await messageCount(stranger.conversationId)).toBe(0);
  });

  it("hides the project from a member who was removed from it", async () => {
    // Also item 49, and the half of it the case above cannot reach. A plain
    // stranger has no conversation that lives in the target project, so the id
    // check refuses them whether or not the project check exists. A removed
    // member does: they opened chat while they still belonged here, so their
    // tab holds an id that is theirs, is in this project, and is not deleted.
    // Only the project check can turn them away — and it must say 404, the
    // same thing it says to anyone else who does not belong.
    const { projectId, studioId } = await seedOwner();
    const member = await insertUser();
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${member}, 'maintainer')
    `;
    await sql`
      INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${projectId}, ${member}, 'editor', null)
    `;
    const memberCookie = await loginCookie(member);
    const opened = (await (
      await app.request("/api/v1/chat/open", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({ project_id: projectId }),
      })
    ).json()) as { data: { current: { conversation: { id: string } } } };
    const conversationId = opened.data.current.conversation.id;

    await sql`
      UPDATE project_members SET deleted_at = now()
      WHERE project_id = ${projectId} AND user_id = ${member}
    `;

    const res = await send(
      {
        message: "I was here a minute ago",
        project_id: projectId,
        conversation_id: conversationId,
      },
      memberCookie,
    );

    expect(res.status).toBe(404);
    expect(await messageCount(conversationId)).toBe(0);
  });

  it("refuses a view-only member of the project", async () => {
    // Item 50. Being able to read the project is not enough: saying something
    // spends the owner's credits and adds to the project's history, so it is
    // judged as a write.
    const { projectId, studioId } = await seedOwner();
    const viewer = await insertUser();
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${viewer}, 'guest')
    `;
    await sql`
      INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${projectId}, ${viewer}, 'viewer', null)
    `;
    const [conversation] = await sql<{ id: string }[]>`
      INSERT INTO conversations (user_id, title, project_id)
      VALUES (${viewer}, 'viewer own', ${projectId}) RETURNING id
    `;

    const res = await send(
      {
        message: "I can only read here",
        project_id: projectId,
        conversation_id: conversation!.id,
      },
      await loginCookie(viewer),
    );

    expect(res.status).toBe(403);
    expect(await messageCount(conversation!.id)).toBe(0);
  });

  it("refuses a member demoted after they already opened chat here", async () => {
    // A role can change under a tab that is already holding a conversation id,
    // and the answer has to change with it. Every id check still passes for
    // that tab — the conversation is theirs, it is in this project, it is not
    // deleted — so, like the two cases above, only the project guard can
    // refuse this, and it goes red the moment that guard is removed. What this
    // one adds is that the role is checked per request rather than once: the
    // view-only member above was never allowed to write, this one was, and the
    // guard has to notice that it stopped being true.
    const { projectId, studioId } = await seedOwner();
    const member = await insertUser();
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${member}, 'maintainer')
    `;
    await sql`
      INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${projectId}, ${member}, 'editor', null)
    `;
    const memberCookie = await loginCookie(member);

    const opened = (await (
      await app.request("/api/v1/chat/open", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({ project_id: projectId }),
      })
    ).json()) as { data: { current: { conversation: { id: string } } } };
    const conversationId = opened.data.current.conversation.id;

    await sql`
      UPDATE project_members SET role = 'viewer'
      WHERE project_id = ${projectId} AND user_id = ${member}
    `;

    const res = await send(
      {
        message: "still typing from the old tab",
        project_id: projectId,
        conversation_id: conversationId,
      },
      memberCookie,
    );

    expect(res.status).toBe(403);
    expect(await messageCount(conversationId)).toBe(0);
  });
});
