// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The hard edge on what one turn may say (#148, G2).
 *
 * The browser stops at ten thousand characters and says so. This is the same
 * line drawn where a client cannot skip it, and it is drawn around the thing
 * that actually reaches the model: what the user typed with their attached
 * canvas content folded in front of it. Checked per field it would pass a
 * message of nine thousand carrying chips worth another nine.
 *
 * The refusal is an error rather than a trim. A silently shortened message
 * leaves the reader unable to see what went missing, reading an answer to
 * something they did not ask.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// `ai` is stubbed: the real SDK is replaced with a double that reaches no
// network, so this suite needs no API key and the SDK stays out of its
// module graph.
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

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "chat-input-limit-test-driver" },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/** A signed-in owner with a project and a conversation in it. */
interface Seeded {
  projectId: string;
  cookie: string;
  conversationId: string;
}

/**
 * Seed an owner with a project, signed in, holding a conversation there.
 * @returns What a well-formed request needs.
 */
async function seedOwner(): Promise<Seeded> {
  const tag = `chat-limit-${seq++}-${Date.now().toString(36)}`;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`${tag}@example.com`}, true) RETURNING id
  `;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`${tag}-studio`}, 'personal', ${tag}) RETURNING id
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
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, user!.id);
  const [conversation] = await sql<{ id: string }[]>`
    INSERT INTO conversations (user_id, title, project_id)
    VALUES (${user!.id}, 'seeded', ${project!.id}) RETURNING id
  `;
  return {
    projectId: project!.id,
    cookie: `${sessionCookieName()}=${token}`,
    conversationId: conversation!.id,
  };
}

/**
 * Post to one of the two chat entrances.
 * @param path - Which entrance.
 * @param body - The request body.
 * @param cookie - The session cookie.
 * @returns The raw response.
 */
async function post(
  path: "/api/v1/chat/message" | "/api/v1/chat/skill",
  body: Record<string, unknown>,
  cookie: string,
): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
}

/**
 * A canvas chip carrying a given weight of text.
 * @param n - Distinguishes it from the others.
 * @param size - How many characters its snapshot holds.
 * @returns The chip, in the shape the wire declares.
 */
function chip(n: number, size: number) {
  return {
    id: `node-${n}`,
    type: "text" as const,
    name: `note ${n}`,
    data_snapshot: { text: "x".repeat(size) },
  };
}

describe("what one turn may send", () => {
  it("refuses a message past the limit", async () => {
    const { projectId, conversationId, cookie } = await seedOwner();

    const res = await post(
      "/api/v1/chat/message",
      {
        message: "y".repeat(20_000),
        project_id: projectId,
        conversation_id: conversationId,
        attached_chips: [],
      },
      cookie,
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("counts the attached canvas content, which the reader never typed", async () => {
    const { projectId, conversationId, cookie } = await seedOwner();

    const res = await post(
      "/api/v1/chat/message",
      {
        message: "have a look at this",
        project_id: projectId,
        conversation_id: conversationId,
        attached_chips: [chip(1, 20_000)],
      },
      cookie,
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("counts them together, so neither half can hide under the line", async () => {
    // The case a per-field check passes: two halves that are each well
    // inside the limit and are sent to the model as one message.
    const { projectId, conversationId, cookie } = await seedOwner();

    const res = await post(
      "/api/v1/chat/message",
      {
        message: "y".repeat(9_000),
        project_id: projectId,
        conversation_id: conversationId,
        attached_chips: [chip(1, 9_000)],
      },
      cookie,
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("refuses a skill command past the limit", async () => {
    const { projectId, conversationId, cookie } = await seedOwner();

    const res = await post(
      "/api/v1/chat/skill",
      {
        skill_name: "brainstorm",
        input: "y".repeat(20_000),
        project_id: projectId,
        conversation_id: conversationId,
      },
      cookie,
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("counts the command the skill route writes around the input", async () => {
    // What goes to the model on this path is `/skill <name> ` and then the
    // input, so an input measured on its own passes the ceiling and the turn
    // sends more than it. The limit is on what one turn may carry, and the
    // command is part of what it carries.
    const { projectId, conversationId, cookie } = await seedOwner();

    const res = await post(
      "/api/v1/chat/skill",
      {
        skill_name: "brainstorm",
        input: "y".repeat(getAgentConfig().user_message_max_chars),
        project_id: projectId,
        conversation_id: conversationId,
      },
      cookie,
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("admits a message that lands exactly on the limit", async () => {
    // The rule is "past the limit", so the line itself goes through. Without
    // this, an off-by-one refuses a message the browser had just told the
    // reader was fine.
    const { projectId, conversationId, cookie } = await seedOwner();

    const res = await post(
      "/api/v1/chat/message",
      {
        message: "y".repeat(getAgentConfig().user_message_max_chars),
        project_id: projectId,
        conversation_id: conversationId,
        attached_chips: [],
      },
      cookie,
    );

    expect(res.status).toBe(200);
  });
});
