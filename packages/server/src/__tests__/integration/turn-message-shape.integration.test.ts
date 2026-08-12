// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The shape a finished turn leaves in the message store.
 *
 * One turn of the assistant is one message. What it did along the way — the
 * tools it called, what they returned, the prose it wrote — are parts of that
 * one message, in the order they happened. This is the model the `parts`
 * column was built for, and the one every chat product renders from: a tool
 * call is a foldable block inside the reply, not a reply of its own.
 *
 * Storing it as several messages instead is what forces every consumer to
 * reassemble it, and each of them gets a different answer — the frontend
 * would have to filter, the acceptance count would stop matching, and the
 * internal marker a tool result carries would ride along into both.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// The stream the model would have produced. Each test sets this before it
// sends, so one double covers every shape a turn can take.
const stream = vi.hoisted(() => ({ parts: [] as unknown[] }));

// What the double was handed on the way out. The store is one half of the
// question and this is the other: a turn is written down in one shape and
// read back out in another, and the tests below check both ends.
const handedToModel = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));

// `ai` is stubbed: no key, no network, and the SDK stays out of the module
// graph. The parts below are what the loop in `main-agent.ts` reads, in the
// order the real SDK delivers them (start-step, tool-call, tool-result,
// finish-step — measured, see the comment at main-agent.ts:225).
vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: (opts: Record<string, unknown>) => (handedToModel.calls.push(opts), {
    fullStream: (async function* () {
      for (const part of stream.parts) yield part;
    })(),
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

const PG_DRIVER_LOCAL = "turn-shape-test-driver";

/** A stored message row, as the assertions below need it. */
interface StoredRow {
  role: string;
  turn_index: number;
  seq: number;
  parts: Array<Record<string, unknown>>;
}

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
 * @returns The project id plus an authenticating Cookie header for the owner.
 * @throws {Error} When any of the seed inserts returns no row.
 */
async function seedProject(): Promise<{ projectId: string; cookie: string }> {
  const tag = `tms-${seq++}`;
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
    projectId: project!.id,
    cookie: `${sessionCookieName()}=${token}`,
  };
}

/**
 * Open chat in a project and return the conversation the server hands back.
 * @param projectId - Project to open chat in.
 * @param cookie - Caller's session cookie.
 * @returns The current conversation's id.
 * @throws {Error} When the endpoint answers with anything but 200.
 */
async function openConversation(projectId: string, cookie: string): Promise<string> {
  const res = await app.request("/api/v1/chat/open", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ project_id: projectId }),
  });
  if (res.status !== 200) throw new Error(`open chat failed: ${res.status}`);
  const body = (await res.json()) as {
    data: { current: { conversation: { id: string } } };
  };
  return body.data.current.conversation.id;
}

/**
 * Send one message and read its stream to the end, so the turn finishes.
 * @param conversationId - Conversation to append to.
 * @param projectId - Project the conversation belongs to.
 * @param cookie - Caller's session cookie.
 * @param text - What the user says.
 * @throws {Error} When the endpoint does not open a stream.
 */
async function sendAndDrain(
  conversationId: string,
  projectId: string,
  cookie: string,
  text: string,
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
  if (res.status !== 200) throw new Error(`send failed: ${res.status}`);
  await res.text();
}

/**
 * Read back every stored row of a conversation, oldest first.
 * @param conversationId - Conversation to read.
 * @returns The rows, ordered the way they were written.
 */
async function storedRows(conversationId: string): Promise<StoredRow[]> {
  return sql<StoredRow[]>`
    SELECT role, turn_index, seq, parts
    FROM conversation_messages
    WHERE conversation_id = ${conversationId} AND deleted_at IS NULL
    ORDER BY turn_index ASC, seq ASC
  `;
}

/**
 * What the model was handed on the most recent call, or nothing yet.
 * @returns The messages of that call, oldest first
 * @throws {Error} When the double was never called
 */
function lastMessagesToModel(): Array<Record<string, unknown>> {
  const last = handedToModel.calls.at(-1);
  if (!last) throw new Error('the model double was never called');
  return last.messages as Array<Record<string, unknown>>;
}

/**
 * Every part of every message the model was handed, flattened.
 * @returns Those parts, in order
 */
function partsToModel(): Array<Record<string, unknown>> {
  return lastMessagesToModel().flatMap((m) =>
    Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : [],
  );
}

describe("carrying a turn that used a tool back to the model", () => {
  // What a tool returned is stored as a string, because that is what a tool
  // returns. The protocol wants it as a typed value, and handing over the
  // bare string fails the whole turn before it leaves — which is what made a
  // conversation unusable from its first tool onward (task #75). One entry
  // point is not enough to check: `/chat/message` and `/chat/skill` both put
  // history in front of the model, and a fix applied to one of them leaves
  // the other failing with nothing to say so.

  it("hands /chat/message a typed tool result, not the stored string", async () => {
    stream.parts = [
      { type: 'tool-call', toolCallId: 'tc-75a', toolName: 'web_search', input: { query: 'noir' } },
      { type: 'tool-result', toolCallId: 'tc-75a', output: 'two links about noir' },
      { type: 'text-delta', text: 'Found some.' },
      { type: 'finish-step', usage: { totalTokens: 40 } },
    ];
    const { projectId, cookie } = await seedProject();
    const conversationId = await openConversation(projectId, cookie);
    await sendAndDrain(conversationId, projectId, cookie, 'find me noir references');

    // Second turn: now the history in front of the model contains that tool.
    stream.parts = [
      { type: 'text-delta', text: 'Sure.' },
      { type: 'finish-step', usage: { totalTokens: 10 } },
    ];
    handedToModel.calls.length = 0;
    await sendAndDrain(conversationId, projectId, cookie, 'and one more');

    const result = partsToModel().find((p) => p.type === 'tool-result');
    expect(result).toMatchObject({
      type: 'tool-result',
      toolCallId: 'tc-75a',
      output: { type: 'text', value: 'two links about noir' },
    });
  });

  it("hands /chat/skill the same typed tool result", async () => {
    stream.parts = [
      { type: 'tool-call', toolCallId: 'tc-75b', toolName: 'web_search', input: { query: 'noir' } },
      { type: 'tool-result', toolCallId: 'tc-75b', output: 'two links about noir' },
      { type: 'text-delta', text: 'Found some.' },
      { type: 'finish-step', usage: { totalTokens: 40 } },
    ];
    const { projectId, cookie } = await seedProject();
    const conversationId = await openConversation(projectId, cookie);
    await sendAndDrain(conversationId, projectId, cookie, 'find me noir references');

    stream.parts = [
      { type: 'text-delta', text: 'Sure.' },
      { type: 'finish-step', usage: { totalTokens: 10 } },
    ];
    handedToModel.calls.length = 0;
    const res = await app.request('/api/v1/chat/skill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        skill_name: 'brainstorm',
        input: 'give me three angles',
        project_id: projectId,
        conversation_id: conversationId,
      }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const result = partsToModel().find((p) => p.type === 'tool-result');
    expect(result).toMatchObject({
      type: 'tool-result',
      toolCallId: 'tc-75b',
      output: { type: 'text', value: 'two links about noir' },
    });
  });
});

describe("what one turn leaves in the store", () => {
  it("keeps a turn that called a tool in a single assistant message", async () => {
    stream.parts = [
      { type: "tool-call", toolCallId: "tc-1", toolName: "web_search", input: { query: "cyberpunk" } },
      { type: "tool-result", toolCallId: "tc-1", output: "three links about cyberpunk" },
      { type: "text-delta", text: "Here is what I found." },
      { type: "finish-step", usage: { totalTokens: 120 } },
    ];

    const { projectId, cookie } = await seedProject();
    const conversationId = await openConversation(projectId, cookie);
    await sendAndDrain(conversationId, projectId, cookie, "find me cyberpunk references");

    const rows = await storedRows(conversationId);
    const assistantRows = rows.filter((r) => r.role === "assistant");

    // One reply, one row. Not one row per thing the reply did.
    expect(assistantRows).toHaveLength(1);

    // And nothing is stored under a role the reply is not.
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant"]);
  });

  it("puts the tool and the prose in that message's parts, in the order they happened", async () => {
    stream.parts = [
      { type: "tool-call", toolCallId: "tc-2", toolName: "web_search", input: { query: "noir" } },
      { type: "tool-result", toolCallId: "tc-2", output: "two links about noir" },
      { type: "text-delta", text: "Here you go." },
      { type: "finish-step", usage: { totalTokens: 90 } },
    ];

    const { projectId, cookie } = await seedProject();
    const conversationId = await openConversation(projectId, cookie);
    await sendAndDrain(conversationId, projectId, cookie, "find me noir references");

    const rows = await storedRows(conversationId);
    const reply = rows.find((r) => r.role === "assistant");

    expect(reply?.parts.map((p) => p.type)).toEqual(["tool", "text"]);

    const toolPart = reply?.parts.find((p) => p.type === "tool");
    expect(toolPart).toMatchObject({
      type: "tool",
      toolCallId: "tc-2",
      toolName: "web_search",
      input: { query: "noir" },
      status: "success",
      output: "two links about noir",
    });

    expect(reply?.parts.find((p) => p.type === "text")).toMatchObject({
      type: "text",
      text: "Here you go.",
    });
  });

  it("never lets the internal marker of an interaction tool reach the store", async () => {
    // `ask_user_choice` answers with a sentinel-prefixed payload. The prefix
    // tells the loop which SSE event to raise and has no meaning past that —
    // the model does not need it and neither does the browser.
    stream.parts = [
      {
        type: "tool-call",
        toolCallId: "tc-3",
        toolName: "ask_user_choice",
        input: { question: "which one?", choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
      },
      {
        type: "tool-result",
        toolCallId: "tc-3",
        output: '__ASK_USER_CHOICE__{"question":"which one?","choices":[{"id":"a","label":"A"},{"id":"b","label":"B"}]}',
      },
      { type: "finish-step", usage: { totalTokens: 60 } },
    ];

    const { projectId, cookie } = await seedProject();
    const conversationId = await openConversation(projectId, cookie);
    await sendAndDrain(conversationId, projectId, cookie, "ask me something");

    const rows = await storedRows(conversationId);
    const everythingStored = JSON.stringify(rows);

    expect(everythingStored).not.toContain("__ASK_USER_CHOICE__");
    expect(everythingStored).not.toContain("__ASK_USER__");

    // The payload itself is still there — only the marker is gone.
    const reply = rows.find((r) => r.role === "assistant");
    const toolPart = reply?.parts.find((p) => p.type === "tool");
    expect(toolPart?.output).toContain("which one?");
  });
});
