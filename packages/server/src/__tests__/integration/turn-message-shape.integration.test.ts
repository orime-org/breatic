// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
const stream = vi.hoisted(() => ({ parts: [] as ModelStreamPart[] }));

// What the double was handed on the way out. The store is one half of the
// question and this is the other: a turn is written down in one shape and
// read back out in another, and the tests below check both ends.
const handedToModel = vi.hoisted(() => ({ calls: [] as Array<{ prompt: unknown }> }));

// 替身在**模型**那一层，不在 `streamText` 上。后端出口现在是
// `createUIMessageStream`，`streamText` 的结果经 `toUIMessageStream()` 变成上线
// 的协议 —— 把 `streamText` 换成替身就等于把这段转换自己 mock 掉，而这几条要
// 钉的正是「存下来的东西再交给模型时长什么样」，那段转换必须真跑。
vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  const { modelProducing } = await import("../helpers/model-double.js");
  return {
    ...actual,
    resolveProvider: () => "test",
    getModel: () =>
      modelProducing(
        () => stream.parts,
        (asked) => handedToModel.calls.push(asked),
      ),
  };
});

import type * as DomainModule from "@breatic/domain";
import crypto from "node:crypto";
import { FINISHED_ASKING_FOR_A_TOOL, saying } from "../helpers/model-double.js";
import type { ModelStreamPart } from "../helpers/model-double.js";
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
  return last.prompt as Array<Record<string, unknown>>;
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

/**
 * 一轮:调一次工具,拿到结果,然后说一句话。
 *
 * 用 `ask_user` 而不是 `web_search`:替身在模型那一层,所以工具由真的
 * `streamText` 按模型的请求真调 —— 而这几条要看的是「工具这件事怎么落库、
 * 怎么再交给模型」,跟是哪个工具无关。`ask_user` 把参数装成一个对象就返回,
 * 不碰网络,也不需要任何 key。
 * @param toolCallId - 这次调用的 id。
 * @param question - 问用户的那句。
 * @param said - 拿到结果之后说的那句。
 * @returns 模型这一轮吐出来的片段,按真实顺序。
 */
function usesATool(toolCallId: string, question: string, said: string): ModelStreamPart[] {
  return [
    {
      type: 'tool-call',
      toolCallId,
      toolName: 'ask_user_question',
      input: JSON.stringify({ question }),
    },
    FINISHED_ASKING_FOR_A_TOOL,
    ...saying(said),
  ];
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
    stream.parts = usesATool('tc-75a', 'which era of noir?', 'Found some.');
    const { projectId, cookie } = await seedProject();
    const conversationId = await openConversation(projectId, cookie);
    await sendAndDrain(conversationId, projectId, cookie, 'find me noir references');

    // Second turn: now the history in front of the model contains that tool.
    stream.parts = saying('Sure.');
    handedToModel.calls.length = 0;
    await sendAndDrain(conversationId, projectId, cookie, 'and one more');

    const result = partsToModel().find((p) => p.type === 'tool-result');
    expect(result).toMatchObject({
      type: 'tool-result',
      toolCallId: 'tc-75a',
      // 有类型的值，不是那个存下来的字符串。裸字符串递过去，整轮在出发前
      // 就失败 —— 一条会话从它第一次用工具起就不能用了（task #75）。
      output: { type: 'json', value: { question: 'which era of noir?', options: [] } },
    });
  });

  it("hands /chat/skill the same typed tool result", async () => {
    stream.parts = usesATool('tc-75b', 'which era of noir?', 'Found some.');
    const { projectId, cookie } = await seedProject();
    const conversationId = await openConversation(projectId, cookie);
    await sendAndDrain(conversationId, projectId, cookie, 'find me noir references');

    stream.parts = saying('Sure.');
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
      output: { type: 'json', value: { question: 'which era of noir?', options: [] } },
    });
  });
});

describe("what one turn leaves in the store", () => {
  it("keeps a turn that called a tool in a single assistant message", async () => {
    stream.parts = usesATool("tc-1", "which era of cyberpunk?", "Here is what I found.");

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
    stream.parts = usesATool("tc-2", "which era of noir?", "Here you go.");

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
      toolName: "ask_user_question",
      input: { question: "which era of noir?" },
      status: "success",
      output: { question: "which era of noir?", options: [] },
    });

    expect(reply?.parts.find((p) => p.type === "text")).toMatchObject({
      type: "text",
      text: "Here you go.",
    });
  });

  // 「哨兵前缀不许进库」那条删了:哨兵机制本身在这次迁移里删掉了,四个交互
  // 工具改成直接返回 payload 对象。它们返回什么、怎么落库,由
  // `domain/src/agent/tools/__tests__/interaction-tools-payload.test.ts` 钉。
});
