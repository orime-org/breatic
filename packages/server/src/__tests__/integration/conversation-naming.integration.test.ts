// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What a conversation is called, and the two routes that write its record.
 *
 * A conversation takes its name from the first thing the user says in it. That
 * is the whole naming rule -- no model is asked to summarise, which would cost
 * a call, can fail, and would need a fallback for when it does.
 *
 * The rule has to be "has this been named yet", not "is this the first
 * message": a conversation whose history was emptied would be renamed over the
 * top of the name its owner chose.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// The SDK is stubbed. These tests POST to /chat/message, which runs a turn and
// reaches `streamText`; without this they would need a key and would talk to a
// vendor. The naming happens before any of that, but the turn still runs.
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
  getAgentConfig,
} from "@breatic/core";
import type { Hono } from "hono";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

const PG_DRIVER_LOCAL = "conversation-naming-test-driver";

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 8,
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
 * Seed a studio with a project and an owner who is signed in.
 * @returns Ids plus an authenticating Cookie header for the owner.
 */
async function seedProject(): Promise<{
  userId: string;
  projectId: string;
  cookie: string;
}> {
  const tag = `cn-${seq++}`;
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
  return {
    userId: user!.id,
    projectId: project!.id,
    cookie: await loginCookie(user!.id),
  };
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
 * Open chat and return the conversation the panel would be showing.
 * @param projectId - Project to open chat in.
 * @param cookie - Caller's session cookie.
 * @returns The current conversation's id.
 */
async function openAndGetId(projectId: string, cookie: string): Promise<string> {
  const res = await app.request("/api/v1/chat/open", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ project_id: projectId }),
  });
  const payload = (await res.json()) as {
    data: { current: { conversation: { id: string } } };
  };
  return payload.data.current.conversation.id;
}

/**
 * Say something in a conversation and wait for the stream to close.
 * @param text - What the user typed.
 * @param projectId - Project the conversation is in.
 * @param conversationId - Conversation being written to.
 * @param cookie - Caller's session cookie.
 */
async function say(
  text: string,
  projectId: string,
  conversationId: string,
  cookie: string,
): Promise<void> {
  const res = await app.request("/api/v1/chat/message", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      message: text,
      project_id: projectId,
      conversation_id: conversationId,
    }),
  });
  await res.text();
}

/**
 * Read a conversation's stored title straight out of the table.
 * @param conversationId - Conversation to read.
 * @returns The title as stored.
 */
async function storedTitle(conversationId: string): Promise<string> {
  const rows = await sql<{ title: string }[]>`
    SELECT title FROM conversations WHERE id = ${conversationId}
  `;
  return rows[0]!.title;
}

describe("A conversation takes its name from the first thing said in it", () => {
  it("names it after the first message", async () => {
    const { projectId, cookie } = await seedProject();
    const conversationId = await openAndGetId(projectId, cookie);
    expect(await storedTitle(conversationId)).toBe("New conversation");

    await say("find me some cyberpunk reference images", projectId, conversationId, cookie);

    expect(await storedTitle(conversationId)).toBe(
      "find me some cyberpunk reference images",
    );
  });

  it("leaves the name alone on every message after the first", async () => {
    const { projectId, cookie } = await seedProject();
    const conversationId = await openAndGetId(projectId, cookie);

    await say("the first thing", projectId, conversationId, cookie);
    await say("something else entirely", projectId, conversationId, cookie);

    expect(await storedTitle(conversationId)).toBe("the first thing");
  });

  it("never writes over a name the owner chose", async () => {
    // The rule is "has it been named", not "is this the first message". A
    // conversation renamed before anyone spoke in it is the case that tells
    // the two apart.
    const { projectId, cookie } = await seedProject();
    const conversationId = await openAndGetId(projectId, cookie);

    const renamed = await app.request(
      `/api/v1/chat/conversations/${conversationId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ project_id: projectId, title: "Storyboard notes" }),
      },
    );
    expect(renamed.status).toBe(200);

    await say("the first thing anyone said here", projectId, conversationId, cookie);

    expect(await storedTitle(conversationId)).toBe("Storyboard notes");
  });

  it("cuts a long first message to the configured length", async () => {
    // Measured against the configured limit, not against the message. The
    // repository truncates to 200 on its way to the column, so "shorter than
    // what was typed" passes with the naming code's own cut removed -- which
    // is what a mutation of that line showed.
    const { projectId, cookie } = await seedProject();
    const conversationId = await openAndGetId(projectId, cookie);
    const limit = getAgentConfig().conversation_title_max_chars;

    await say("a".repeat(500), projectId, conversationId, cookie);

    const title = await storedTitle(conversationId);
    expect(title).toHaveLength(limit);
    expect(title.endsWith("…")).toBe(true);
  });

  it("keeps a first message that already fits, ellipsis and all", async () => {
    // The pair to the one above: without it, cutting everything to the limit
    // regardless of length would pass.
    const { projectId, cookie } = await seedProject();
    const conversationId = await openAndGetId(projectId, cookie);

    await say("short enough", projectId, conversationId, cookie);

    expect(await storedTitle(conversationId)).toBe("short enough");
  });

  it("folds a message typed across several lines into one", async () => {
    // A title with a newline in it shows only what came before the break.
    const { projectId, cookie } = await seedProject();
    const conversationId = await openAndGetId(projectId, cookie);

    await say("first line\n\nsecond line", projectId, conversationId, cookie);

    expect(await storedTitle(conversationId)).toBe("first line second line");
  });

  it("tells the client the name in the event that opens the turn", async () => {
    // Without this the list and the header go on showing "New conversation"
    // until the reader leaves the project and comes back.
    const { projectId, cookie } = await seedProject();
    const conversationId = await openAndGetId(projectId, cookie);

    const res = await app.request("/api/v1/chat/message", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        message: "name this conversation",
        project_id: projectId,
        conversation_id: conversationId,
      }),
    });
    const body = await res.text();

    const started = body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as { event: string; data: Record<string, unknown> })
      .find((e) => e.event === "chat_turn_started");

    expect(started).toBeDefined();
    expect(started!.data['title']).toBe("name this conversation");
  });
});

describe("POST /chat/conversations — starting one on purpose", () => {
  it("makes a second conversation in a project that already has one", async () => {
    const { projectId, cookie } = await seedProject();
    const first = await openAndGetId(projectId, cookie);

    const res = await app.request("/api/v1/chat/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ project_id: projectId }),
    });

    expect(res.status).toBe(200);
    const payload = (await res.json()) as { data: { id: string; title: string } };
    expect(payload.data.id).not.toBe(first);
    expect(payload.data.title).toBe("New conversation");

    const rows = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM conversations
      WHERE project_id = ${projectId} AND deleted_at IS NULL
    `;
    expect(Number(rows[0]!.n)).toBe(2);
  });

  it("refuses someone with no part in the project, and creates nothing", async () => {
    const { projectId } = await seedProject();
    const [outsider] = await sql<{ id: string }[]>`
      INSERT INTO users (email, email_verified)
      VALUES (${`cn-out-${seq++}@example.com`}, true) RETURNING id
    `;

    const res = await app.request("/api/v1/chat/conversations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: await loginCookie(outsider!.id),
      },
      body: JSON.stringify({ project_id: projectId }),
    });

    expect(res.status).toBe(404);
    const rows = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM conversations WHERE project_id = ${projectId}
    `;
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

describe("PATCH /chat/conversations/:id — who may name one", () => {
  it("answers 404 for a conversation belonging to someone else", async () => {
    // Not 403. A distinguishable answer would confirm the conversation exists.
    const mine = await seedProject();
    const theirs = await seedProject();
    const theirConversation = await openAndGetId(theirs.projectId, theirs.cookie);

    const res = await app.request(
      `/api/v1/chat/conversations/${theirConversation}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: mine.cookie },
        body: JSON.stringify({ project_id: theirs.projectId, title: "mine now" }),
      },
    );

    expect(res.status).toBe(404);
    expect(await storedTitle(theirConversation)).toBe("New conversation");
  });

  it("answers 404 when the conversation is in a different project", async () => {
    const { projectId, cookie, userId } = await seedProject();
    const conversationId = await openAndGetId(projectId, cookie);
    const [other] = await sql<{ id: string }[]>`
      INSERT INTO projects (studio_id, created_by_user_id, name, slug, visibility)
      SELECT studio_id, ${userId}, 'other', ${`cn-other-${seq++}`}, 'private'
      FROM projects WHERE id = ${projectId} RETURNING id
    `;

    const res = await app.request(`/api/v1/chat/conversations/${conversationId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ project_id: other!.id, title: "wrong project" }),
    });

    expect(res.status).toBe(404);
    expect(await storedTitle(conversationId)).toBe("New conversation");
  });

  it("answers 404 for a conversation that has been deleted", async () => {
    const { projectId, cookie } = await seedProject();
    const conversationId = await openAndGetId(projectId, cookie);
    await sql`UPDATE conversations SET deleted_at = now() WHERE id = ${conversationId}`;

    const res = await app.request(`/api/v1/chat/conversations/${conversationId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ project_id: projectId, title: "back from the dead" }),
    });

    expect(res.status).toBe(404);
  });
});

describe("GET /chat/conversations/:id — reading one to switch into it", () => {
  it("says whether the conversation reaches back further than this page", async () => {
    // Switching conversations loads one this way. Without `hasMore` the panel
    // it lands in cannot know whether "load earlier" has anything to load.
    const { projectId, cookie } = await seedProject();
    const conversationId = await openAndGetId(projectId, cookie);
    await say("something", projectId, conversationId, cookie);

    const res = await app.request(`/api/v1/chat/conversations/${conversationId}`, {
      headers: { Cookie: cookie },
    });

    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      data: { messages: unknown[]; hasMore: boolean };
    };
    expect(payload.data.hasMore).toBe(false);
    expect(payload.data.messages.length).toBeGreaterThan(0);
  });
});
