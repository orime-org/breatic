// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The hard edge on what one turn may say (#148, G2).
 *
 * Two lines, each drawn where a client cannot skip it: one on what the user
 * typed (the browser stops at ten thousand characters and says so), one on
 * the attached items as the model is sent them. The attachments do not eat
 * into what the reader may type, and a long question does not shrink what
 * may be attached.
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
import { attachmentMarker, attachmentSection } from "@breatic/shared";

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
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studio!.id}, ${user!.id}, ${tag}, ${`${tag}-p`}) RETURNING id
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
 * Post to the chat entrance.
 * @param path - The entrance.
 * @param body - The request body.
 * @param cookie - The session cookie.
 * @returns The raw response.
 */
async function post(
  path: "/api/v1/chat/message",
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

/**
 * A text chip whose laid-out attachment section is exactly a given length.
 * @param length - How long the section should be.
 * @returns The chip.
 */
function chipWithSection(length: number) {
  const bare = attachmentSection([chip(1, 0)]).length;
  return chip(1, length - bare);
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

  it("counts each reference to an attachment as one character", async () => {
    // The box counts a reference as the one block the reader sees, so the
    // server has to as well: the marker it is written as is longer.
    const { projectId, conversationId, cookie } = await seedOwner();
    const attached = chip(1, 10);
    const references = attachmentMarker(attached.id).repeat(5);

    const res = await post(
      "/api/v1/chat/message",
      {
        message: references + "y".repeat(getAgentConfig().user_message_max_chars - 5),
        project_id: projectId,
        conversation_id: conversationId,
        attached_chips: [attached],
      },
      cookie,
    );

    expect(res.status).toBe(200);
  });

  it("measures the attachments apart from the words", async () => {
    // Each half is under its own limit, and together they are past the limit
    // on the words: the attachments do not eat into what the reader may type.
    const { projectId, conversationId, cookie } = await seedOwner();

    const res = await post(
      "/api/v1/chat/message",
      {
        message: "y".repeat(getAgentConfig().user_message_max_chars),
        project_id: projectId,
        conversation_id: conversationId,
        attached_chips: [chip(1, 20_000)],
      },
      cookie,
    );

    expect(res.status).toBe(200);
  });

  it("admits attachments that land exactly on their limit", async () => {
    const { projectId, conversationId, cookie } = await seedOwner();

    const res = await post(
      "/api/v1/chat/message",
      {
        message: "have a look at this",
        project_id: projectId,
        conversation_id: conversationId,
        attached_chips: [chipWithSection(getAgentConfig().attachment_max_chars)],
      },
      cookie,
    );

    expect(res.status).toBe(200);
  });

  it("refuses more attached items than one message may carry", async () => {
    const { projectId, conversationId, cookie } = await seedOwner();
    const max = getAgentConfig().attachment_max_items;

    const res = await post(
      "/api/v1/chat/message",
      {
        message: "have a look at these",
        project_id: projectId,
        conversation_id: conversationId,
        attached_chips: Array.from({ length: max + 1 }, (_, i) => chip(i, 1)),
      },
      cookie,
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("refuses attachments past their limit", async () => {
    const { projectId, conversationId, cookie } = await seedOwner();

    const res = await post(
      "/api/v1/chat/message",
      {
        message: "have a look at this",
        project_id: projectId,
        conversation_id: conversationId,
        attached_chips: [chipWithSection(getAgentConfig().attachment_max_chars + 1)],
      },
      cookie,
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
