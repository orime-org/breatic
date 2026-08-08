// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Every door into chat names a project, never a conversation.
 *
 * Acceptance items 11 and 15. There are two ways in — sending a message and
 * invoking a skill — and one way to read back what is there. All three used to
 * involve a conversation id; now none of them does, because the server holds
 * the pointer.
 *
 * Item 15 pins the two write entrances against the quiet failure of changing
 * only one: the skill entrance would create a conversation of its own, and
 * everything said through it would land somewhere the chat panel never shows.
 * It drives the two in sequence through the real app — skill first, in a
 * project with no conversation at all, then an ordinary message — and requires
 * the second to land where the first one did.
 *
 * Item 11 pins the read side. Without it a user sends a message, refreshes,
 * and stares at an empty panel: the list endpoint marks nothing as current, so
 * nothing else can answer "what am I looking at in this project".
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// Mock `ai` BEFORE importing @breatic/core / the app. The turn runs for real
// here; only the model call is stubbed, with a stream that ends immediately.
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

const PG_DRIVER_LOCAL = "chat-entrances-test-driver";

/** A skill the routing config marks usable from chat by a user. */
const CHAT_SKILL = "brainstorm";

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
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
 * Seed an owner with a studio and a project they may write to, plus a session.
 * @returns The project id and an authenticating Cookie header.
 */
async function seedSignedInOwner(): Promise<{
  userId: string;
  projectId: string;
  cookie: string;
}> {
  const tag = `ce-${seq++}`;
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
  return {
    userId: user!.id,
    projectId: project!.id,
    cookie: `${sessionCookieName()}=${token}`,
  };
}

describe("reading back what is in front of you", () => {
  it("answers with nothing at all in a project never chatted in", async () => {
    const { projectId, cookie } = await seedSignedInOwner();

    const res = await app.request(`/api/v1/chat/current?project_id=${projectId}`, {
      headers: { Cookie: cookie },
    });

    // A project you have never chatted in is a normal state, not a missing
    // resource — so it answers, rather than 404s.
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      data: { conversation: unknown; messages: unknown[] };
    };
    expect(payload.data.conversation).toBeNull();
    expect(payload.data.messages).toEqual([]);
  });

  it("hands back the current conversation's messages in the order they were said", async () => {
    const { projectId, cookie } = await seedSignedInOwner();
    const headers = { "Content-Type": "application/json", Cookie: cookie };

    for (const message of ["first thing", "second thing", "third thing"]) {
      const sent = await app.request("/api/v1/chat/message", {
        method: "POST",
        headers,
        body: JSON.stringify({ message, project_id: projectId }),
      });
      expect(sent.status).toBe(200);
      await sent.text();
    }

    // Note what is NOT in this request: a conversation id. The client names a
    // project and gets back whatever it is currently in.
    const res = await app.request(`/api/v1/chat/current?project_id=${projectId}`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);

    const payload = (await res.json()) as {
      data: {
        conversation: { id: string } | null;
        messages: Array<{ role: string; content: string }>;
      };
    };
    expect(payload.data.conversation).not.toBeNull();
    expect(
      payload.data.messages.filter((m) => m.role === "user").map((m) => m.content),
    ).toEqual(["first thing", "second thing", "third thing"]);
  });
});

describe("the two entrances into chat", () => {
  it("lands a skill invocation and a following message in one conversation", async () => {
    const { userId, projectId, cookie } = await seedSignedInOwner();
    const headers = { "Content-Type": "application/json", Cookie: cookie };

    // Nothing exists yet: no conversation, no pointer.
    const skillRes = await app.request("/api/v1/chat/skill", {
      method: "POST",
      headers,
      body: JSON.stringify({
        skill_name: CHAT_SKILL,
        input: "give me three angles",
        project_id: projectId,
      }),
    });
    expect(skillRes.status).toBe(200);
    // Drain the stream so the turn finishes before anything is asserted.
    await skillRes.text();

    const afterSkill = await sql<{ conversation_id: string }[]>`
      SELECT conversation_id FROM current_conversations
      WHERE user_id = ${userId} AND project_id = ${projectId}
    `;
    // The skill entrance has to leave the pointer behind, or the panel would
    // never show what the user just did.
    expect(afterSkill).toHaveLength(1);
    const conversationId = afterSkill[0]!.conversation_id;

    const messageRes = await app.request("/api/v1/chat/message", {
      method: "POST",
      headers,
      body: JSON.stringify({ message: "and one more", project_id: projectId }),
    });
    expect(messageRes.status).toBe(200);
    await messageRes.text();

    // Same pointer, so the same conversation.
    const afterMessage = await sql<{ conversation_id: string }[]>`
      SELECT conversation_id FROM current_conversations
      WHERE user_id = ${userId} AND project_id = ${projectId}
    `;
    expect(afterMessage[0]!.conversation_id).toBe(conversationId);

    // And both user messages really are in that one conversation.
    const rows = await sql<{ conversation_id: string; parts: unknown }[]>`
      SELECT conversation_id, parts FROM conversation_messages
      WHERE user_id = ${userId} AND role = 'user'
      ORDER BY created_at
    `;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.conversation_id)).toEqual([conversationId, conversationId]);

    // Exactly one conversation was created across both entrances.
    const conversations = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM conversations WHERE project_id = ${projectId}
    `;
    expect(Number(conversations[0]!.n)).toBe(1);
  });
});
