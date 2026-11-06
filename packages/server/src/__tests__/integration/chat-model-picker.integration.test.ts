// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The model the reader picks in the chat panel (#1363).
 *
 * Each conversation keeps its own model, server side; a new conversation
 * starts on the model the reader last picked, and so does a conversation from
 * before the picker until its next message writes one. A pick is checked like
 * a rename: this reader's conversation, in this Project, not deleted. A model
 * the deployment no longer lists is refused when sent (422, the code every
 * refused value gets here), and skipped when read.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    streamText: () => ({
      fullStream: (async function* () {})(),
      toUIMessageStream: () => new ReadableStream({ start: (c) => c.close() }),
      text: Promise.resolve(""),
      usage: Promise.resolve({ totalTokens: 0 }),
      totalUsage: Promise.resolve({ totalTokens: 0 }),
    }),
  };
});

import crypto from "node:crypto";
import postgres from "postgres";
import { initCore, getRedis, setSession, sessionCookieName, loadLocales, getAgentConfig } from "@breatic/core";
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
    max: 6,
    prepare: false,
    connection: { application_name: "chat-model-picker-test-driver" },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

const DEEPSEEK = { id: "deepseek/deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash" };
const SONNET = { id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5" };
const OPUS = { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5" };

let seq = 0;

/** A signed-in member with a Project. */
interface Reader {
  userId: string;
  projectId: string;
  cookie: string;
}

/**
 * Seed a signed-in owner with a project.
 * @returns Their ids and session cookie.
 */
async function seedReader(): Promise<Reader> {
  const tag = `cmp-${seq++}-${Date.now().toString(36)}`;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`${tag}@example.com`}, true) RETURNING id
  `;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`${tag}-studio`}, 'team', ${tag}) RETURNING id
  `;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${user!.id}, 'admin')`;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studio!.id}, ${user!.id}, ${tag}, ${`${tag}-p`}) RETURNING id
  `;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${project!.id}, ${user!.id}, 'owner', null)
  `;
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, user!.id);
  return { userId: user!.id, projectId: project!.id, cookie: `${sessionCookieName()}=${token}` };
}

/**
 * Call the API as a reader.
 * @param reader - Who.
 * @param method - The method.
 * @param path - The path under /api/v1.
 * @param body - The JSON body, when there is one.
 * @returns The response.
 */
async function call(reader: Reader, method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(`/api/v1${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: reader.cookie,
      "Idempotency-Key": crypto.randomUUID(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * Open chat in the reader's Project.
 * @param reader - Who.
 * @returns The current conversation as the open answers it.
 */
async function open(reader: Reader): Promise<{ id: string; agentModel: { id: string; name: string } }> {
  const res = await call(reader, "POST", "/chat/open", { project_id: reader.projectId });
  const body = (await res.json()) as { data: { current: { conversation: { id: string; agentModel: { id: string; name: string } } } } };
  return body.data.current.conversation;
}

/**
 * Start another conversation in the reader's Project.
 * @param reader - Who.
 * @returns It, as the create answers it.
 */
async function createConversation(reader: Reader): Promise<{ id: string; agentModel: { id: string; name: string } }> {
  const res = await call(reader, "POST", "/chat/conversations", { project_id: reader.projectId });
  return ((await res.json()) as { data: { id: string; agentModel: { id: string; name: string } } }).data;
}

/**
 * Pick a model in a conversation.
 * @param reader - Who.
 * @param conversationId - Which conversation.
 * @param model - The model id.
 * @param projectId - The Project named in the body.
 * @returns The response.
 */
async function pick(reader: Reader, conversationId: string, model: string, projectId = reader.projectId): Promise<Response> {
  return call(reader, "PUT", `/chat/conversations/${conversationId}/model`, { project_id: projectId, model });
}

/**
 * The two stored picks.
 * @param reader - Whose.
 * @param conversationId - Which conversation.
 * @returns The conversation's model and the reader's last pick.
 */
async function stored(reader: Reader, conversationId: string): Promise<{ conversation: string | null; user: string | null }> {
  const [c] = await sql<{ agent_model: string | null }[]>`SELECT agent_model FROM conversations WHERE id = ${conversationId}`;
  const [u] = await sql<{ agent_model: string | null }[]>`SELECT agent_model FROM users WHERE id = ${reader.userId}`;
  return { conversation: c!.agent_model, user: u!.agent_model };
}

describe("GET /chat/models", () => {
  it("lists the models the reader can pick, in order, and the one a new conversation starts on", async () => {
    const reader = await seedReader();

    const res = await call(reader, "GET", "/chat/models");
    const body = (await res.json()) as { data: { models: unknown; lastUsed: string } };

    expect(res.status).toBe(200);
    expect(body.data.models).toEqual([DEEPSEEK, SONNET, OPUS]);
    expect(body.data.lastUsed).toBe(getAgentConfig().default_model);
  });
});

describe("each conversation keeps its own model", () => {
  it("starts the first conversation on the default and writes it down", async () => {
    const reader = await seedReader();

    const first = await open(reader);

    expect(first.agentModel).toEqual(DEEPSEEK);
    expect((await stored(reader, first.id)).conversation).toBe(DEEPSEEK.id);
  });

  it("keeps a pick to its conversation, records it as the last pick, and starts the next conversation on it", async () => {
    const reader = await seedReader();
    const first = await open(reader);

    const res = await pick(reader, first.id, SONNET.id);
    const second = await createConversation(reader);
    await pick(reader, second.id, OPUS.id);
    const firstAgain = (await (await call(reader, "GET", `/chat/conversations/${first.id}`)).json()) as {
      data: { conversation: { agentModel: { id: string } } };
    };

    expect(res.status).toBe(200);
    expect(second.agentModel).toEqual(SONNET);
    expect(firstAgain.data.conversation.agentModel).toEqual(SONNET);
    expect(await stored(reader, first.id)).toEqual({ conversation: SONNET.id, user: OPUS.id });
    expect((await stored(reader, second.id)).conversation).toBe(OPUS.id);
  });

  it("starts the conversation the open creates on the last pick, and writes it down", async () => {
    const reader = await seedReader();
    const first = await open(reader);
    await pick(reader, first.id, OPUS.id);
    await sql`UPDATE conversations SET deleted_at = now() WHERE id = ${first.id}`;

    const created = await open(reader);

    expect(created.id).not.toBe(first.id);
    expect(created.agentModel).toEqual(OPUS);
    expect((await stored(reader, created.id)).conversation).toBe(OPUS.id);
  });

  it("starts a conversation from before the picker on the last pick, until its next message writes one", async () => {
    const reader = await seedReader();
    const first = await open(reader);
    await pick(reader, first.id, OPUS.id);
    await sql`UPDATE conversations SET agent_model = NULL WHERE id = ${first.id}`;

    const reopened = await open(reader);

    expect(reopened.agentModel).toEqual(OPUS);
  });

  it("skips a stored model the deployment no longer lists", async () => {
    const reader = await seedReader();
    const first = await open(reader);
    await sql`UPDATE conversations SET agent_model = 'retired/model' WHERE id = ${first.id}`;
    await sql`UPDATE users SET agent_model = 'retired/model' WHERE id = ${reader.userId}`;

    const reopened = await open(reader);

    expect(reopened.agentModel).toEqual(DEEPSEEK);
  });
});

describe("PUT /chat/conversations/:id/model", () => {
  it("refuses a model the deployment does not list, and writes nothing", async () => {
    const reader = await seedReader();
    const first = await open(reader);

    const res = await pick(reader, first.id, "retired/model");

    expect(res.status).toBe(422);
    expect(await stored(reader, first.id)).toEqual({ conversation: DEEPSEEK.id, user: null });
  });

  it("answers 404 for someone else's conversation, another Project's, and a deleted one", async () => {
    const reader = await seedReader();
    const stranger = await seedReader();
    const theirs = await open(stranger);
    const mine = await open(reader);
    const other = await seedReader();
    await sql`
      INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${other.projectId}, ${reader.userId}, 'editor', null)
    `;
    const deleted = await createConversation(reader);
    await sql`UPDATE conversations SET deleted_at = now() WHERE id = ${deleted.id}`;

    expect((await pick(reader, theirs.id, SONNET.id)).status).toBe(404);
    expect((await pick(reader, mine.id, SONNET.id, other.projectId)).status).toBe(404);
    expect((await pick(reader, deleted.id, SONNET.id)).status).toBe(404);
    expect((await stored(stranger, theirs.id)).conversation).toBe(DEEPSEEK.id);
  });
});

describe("POST /chat/message with a model", () => {
  it("refuses a model the deployment does not list, with the reader's sentence, and stores no message", async () => {
    const reader = await seedReader();
    const first = await open(reader);

    const res = await call(reader, "POST", "/chat/message", {
      project_id: reader.projectId,
      conversation_id: first.id,
      message: "hello",
      model: "retired/model",
    });
    const body = (await res.json()) as { error: { message: string } };
    const [count] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conversation_messages WHERE conversation_id = ${first.id}
    `;

    expect(res.status).toBe(422);
    expect(body.error.message).toBe("The selected model is no longer available.");
    expect(count!.n).toBe(0);
  });

  it("writes the model it is answered by into the conversation before the turn runs", async () => {
    const reader = await seedReader();
    const first = await open(reader);
    await sql`UPDATE conversations SET agent_model = NULL WHERE id = ${first.id}`;

    const res = await call(reader, "POST", "/chat/message", {
      project_id: reader.projectId,
      conversation_id: first.id,
      message: "hello",
      model: SONNET.id,
    });
    await res.text();

    expect((await stored(reader, first.id)).conversation).toBe(SONNET.id);
  });
});

describe("a turn resumed by an answer to its card", () => {
  /**
   * Leave a reply waiting at a questionnaire, recorded as started on a model.
   * @param conversationId - The conversation.
   * @param modelId - The model the turn started on, as its reply records it.
   * @returns The waiting call's id.
   */
  async function pausedAt(conversationId: string, modelId: string): Promise<string> {
    const toolCallId = `call-${crypto.randomUUID()}`;
    const messageRepo = await import("@server/modules/conversation/conversation-message.repo.js");
    await messageRepo.addMessage(
      conversationId,
      {
        role: "assistant",
        parts: [{ type: "tool", toolCallId, toolName: "ask_user", input: { questions: [] }, status: "awaiting" }],
        turnIndex: 1,
      },
      { messages: [], prefixHash: "h", turnTokens: 0, endTokens: 0, modelId },
    );
    return toolCallId;
  }

  it("runs on the model the turn started on, whatever the picker shows now", async () => {
    const { conversationService } = await import("@server/modules");
    const reader = await seedReader();
    const first = await open(reader);
    const toolCallId = await pausedAt(first.id, OPUS.id);
    await pick(reader, first.id, SONNET.id);

    expect(await conversationService.modelForResume(first.id, reader.userId, toolCallId)).toBe(OPUS.id);
  });

  it("runs on the conversation's model when the one it started on is no longer listed, and does not refuse", async () => {
    const { conversationService } = await import("@server/modules");
    const reader = await seedReader();
    const first = await open(reader);
    const toolCallId = await pausedAt(first.id, "retired/model");
    await pick(reader, first.id, SONNET.id);

    expect(await conversationService.modelForResume(first.id, reader.userId, toolCallId)).toBe(SONNET.id);
  });
});
