// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The conversation id the client sends, and what the server does with it.
 *
 * Acceptance items 14, 15 and 20. The client now decides where its message
 * lands, which is what makes two tabs on two conversations work — and which is
 * also a surface the previous design did not have. An id that arrives from
 * outside has to be checked against three things before anything is written to
 * it: it must belong to this user, live in this project, and still exist.
 *
 * Both entrances take the same id and must treat it the same way; a check on
 * one of them only is the failure this suite is built to catch.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

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

const PG_DRIVER_LOCAL = "chat-conversation-id-test-driver";

/** A skill the routing config marks usable from chat by a user. */
const CHAT_SKILL = "brainstorm";

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 6,
    prepare: false,
    connection: { application_name: PG_DRIVER_LOCAL },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/**
 * Seed a signed-in owner with a project, and open chat so a conversation exists.
 * @returns Ids, a cookie, and the conversation the open call produced.
 */
async function seedOpenedProject(): Promise<{
  userId: string;
  studioId: string;
  projectId: string;
  cookie: string;
  conversationId: string;
}> {
  const tag = `cid-${seq++}`;
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
  await sql`
    INSERT INTO credit_balances (user_id, balance) VALUES (${user!.id}, 100000)
    ON CONFLICT (user_id) DO UPDATE SET balance = 100000
  `;

  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, user!.id);
  const cookie = `${sessionCookieName()}=${token}`;

  const opened = (await (
    await app.request("/api/v1/chat/open", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ project_id: project!.id }),
    })
  ).json()) as { data: { current: { conversation: { id: string } } } };

  return {
    userId: user!.id,
    studioId: studio!.id,
    projectId: project!.id,
    cookie,
    conversationId: opened.data.current.conversation.id,
  };
}

/**
 * Post a message.
 * @param body - Request body, so a caller can omit or corrupt fields.
 * @param cookie - Caller's session cookie.
 * @returns The raw response.
 */
async function send(body: Record<string, unknown>, cookie: string): Promise<Response> {
  return app.request("/api/v1/chat/message", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
}

/**
 * Count messages in a conversation.
 * @param conversationId - Conversation to count in.
 * @returns The row count.
 */
async function messageCount(conversationId: string): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM conversation_messages WHERE conversation_id = ${conversationId}
  `;
  return Number(rows[0]!.n);
}

describe("the conversation id is required", () => {
  it("refuses a message with no conversation id", async () => {
    const { projectId, cookie } = await seedOpenedProject();

    // Opening chat always hands the client a conversation, so a message
    // without one is a client that skipped that step, not a first-ever message.
    const res = await send({ message: "hello", project_id: projectId }, cookie);

    expect(res.status).toBe(400);
  });

  it("refuses a skill invocation with no conversation id", async () => {
    const { projectId, cookie } = await seedOpenedProject();

    const res = await app.request("/api/v1/chat/skill", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ skill_name: CHAT_SKILL, input: "go", project_id: projectId }),
    });

    expect(res.status).toBe(400);
  });
});

describe("the conversation id is checked before anything is written", () => {
  it("refuses someone else's conversation", async () => {
    const mine = await seedOpenedProject();
    const theirs = await seedOpenedProject();

    const res = await send(
      { message: "into your conversation", project_id: mine.projectId, conversation_id: theirs.conversationId },
      mine.cookie,
    );

    expect(res.status).toBe(404);
    expect(await messageCount(theirs.conversationId)).toBe(0);
  });

  it("refuses a fellow member's conversation in the same project", async () => {
    const owner = await seedOpenedProject();

    // Both people are editors in ONE project, so "is it in this project?"
    // passes for both of them — only "is it yours?" can refuse this one. The
    // earlier test does not reach that check, because those two users are in
    // separate projects.
    const [mate] = await sql<{ id: string }[]>`
      INSERT INTO users (email, email_verified)
      VALUES (${`cid-mate-${seq++}@example.com`}, true) RETURNING id
    `;
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role)
      VALUES (${owner.studioId}, ${mate!.id}, 'maintainer')
    `;
    await sql`
      INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${owner.projectId}, ${mate!.id}, 'editor', null)
    `;
    await sql`
      INSERT INTO credit_balances (user_id, balance) VALUES (${mate!.id}, 100000)
      ON CONFLICT (user_id) DO UPDATE SET balance = 100000
    `;
    const token = crypto.randomBytes(24).toString("hex");
    await setSession(getRedis(), token, mate!.id);
    const mateCookie = `${sessionCookieName()}=${token}`;

    const res = await send(
      {
        message: "into my colleague's conversation",
        project_id: owner.projectId,
        conversation_id: owner.conversationId,
      },
      mateCookie,
    );

    expect(res.status).toBe(404);
    expect(await messageCount(owner.conversationId)).toBe(0);
  });

  it("refuses my own conversation from a different project", async () => {
    const here = await seedOpenedProject();

    // Same owner, second project, its own conversation.
    const [project] = await sql<{ id: string }[]>`
      INSERT INTO projects (studio_id, created_by_user_id, name, slug, visibility)
      VALUES (${here.studioId}, ${here.userId}, 'second', ${`second-${seq++}`}, 'private') RETURNING id
    `;
    await sql`
      INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${project!.id}, ${here.userId}, 'owner', null)
    `;
    const elsewhere = (await (
      await app.request("/api/v1/chat/open", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: here.cookie },
        body: JSON.stringify({ project_id: project!.id }),
      })
    ).json()) as { data: { current: { conversation: { id: string } } } };
    const elsewhereId = elsewhere.data.current.conversation.id;

    const res = await send(
      { message: "wrong project", project_id: here.projectId, conversation_id: elsewhereId },
      here.cookie,
    );

    expect(res.status).toBe(404);
    expect(await messageCount(elsewhereId)).toBe(0);
  });

  it("refuses a conversation that was deleted while a tab still held its id", async () => {
    const { projectId, cookie, conversationId } = await seedOpenedProject();

    // The ordinary way this happens: one tab is sitting on this conversation
    // while the user deletes it from another. Neither of the two checks above
    // catches it — it is this user's own conversation, in this project.
    await app.request(`/api/v1/chat/conversations/${conversationId}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });

    const res = await send(
      { message: "still typing here", project_id: projectId, conversation_id: conversationId },
      cookie,
    );

    expect(res.status).toBe(404);
  });
});

describe("both entrances treat the id the same way", () => {
  it("lands a skill invocation and a message in the conversation they name", async () => {
    const { projectId, cookie, conversationId } = await seedOpenedProject();

    const skillRes = await app.request("/api/v1/chat/skill", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        skill_name: CHAT_SKILL,
        input: "three angles",
        project_id: projectId,
        conversation_id: conversationId,
      }),
    });
    expect(skillRes.status).toBe(200);
    await skillRes.text();

    const messageRes = await send(
      { message: "and one more", project_id: projectId, conversation_id: conversationId },
      cookie,
    );
    expect(messageRes.status).toBe(200);
    await messageRes.text();

    const rows = await sql<{ conversation_id: string; turn_index: number }[]>`
      SELECT conversation_id, turn_index FROM conversation_messages
      WHERE role = 'user' ORDER BY created_at
    `;
    const mine = rows.filter((r) => r.conversation_id === conversationId);
    expect(mine).toHaveLength(2);
    // Consecutive turns in one conversation, not two conversations of one turn.
    expect(mine.map((r) => r.turn_index)).toEqual([1, 2]);
  });

  it("refuses someone else's conversation on the skill entrance too", async () => {
    const mine = await seedOpenedProject();
    const theirs = await seedOpenedProject();

    const res = await app.request("/api/v1/chat/skill", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: mine.cookie },
      body: JSON.stringify({
        skill_name: CHAT_SKILL,
        input: "go",
        project_id: mine.projectId,
        conversation_id: theirs.conversationId,
      }),
    });

    expect(res.status).toBe(404);
    expect(await messageCount(theirs.conversationId)).toBe(0);
  });
});
