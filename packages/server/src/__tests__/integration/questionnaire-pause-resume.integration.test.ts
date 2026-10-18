// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A questionnaire pauses the turn, and the reader's answer resumes it
 * (inner#1542).
 *
 * The agent's `ask_user` call has no result until the reader gives one: the
 * segment of the turn that asked stops there, the call is stored as
 * `awaiting`, and the answer comes back as that call's result -- either from
 * the card, which resumes the same turn, or as word that the reader wrote a
 * message instead. Whichever way it comes, the call and its result sit in the
 * same stored row, so every later request in the conversation carries a call
 * with its result; a call left without one makes the SDK refuse every
 * request after it (`MissingToolResultsError`).
 *
 * The model is a double, and everything else is real: the route, the turn,
 * the store and the SDK's own conversion of what is replayed.
 */
import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

/** What the model says, one script per call; empty means a short reply. */
const model = vi.hoisted(() => ({
  queue: [] as ModelStreamPart[][],
  calls: [] as Array<{ prompt: unknown }>,
}));

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  const { modelProducing, saying } = await import("../helpers/model-double.js");
  return {
    ...actual,
    resolveProvider: () => "deepseek",
    getModel: () =>
      modelProducing(
        () => model.queue.shift() ?? saying("ok"),
        (asked) => model.calls.push(asked),
      ),
  };
});

import type * as DomainModule from "@breatic/domain";
import crypto from "node:crypto";
import fc from "fast-check";
import postgres from "postgres";
import { initCore, getRedis, setSession, sessionCookieName, loadLocales } from "@breatic/core";
import type { Hono } from "hono";
import { FINISHED_ASKING_FOR_A_TOOL } from "../helpers/model-double.js";
import type { ModelStreamPart } from "../helpers/model-double.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), { max: 8, prepare: false });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/** A stored message row, as the assertions read it. */
interface StoredRow {
  role: string;
  turn_index: number;
  seq: number;
  parts: Array<Record<string, unknown>>;
  for_model: { messages?: Array<Record<string, unknown>> } | null;
}

/** The questionnaire the model asks in these cases. */
const QUESTIONS = {
  questions: [
    { header: "Ratio", question: "Which ratio?", options: [{ label: "16:9" }, { label: "9:16" }] },
    { header: "Mood", question: "Any mood in mind?" },
  ],
};

let seq = 0;

/**
 * Seed a studio with a project and an owner who is signed in.
 * @returns The ids and an authenticating Cookie header.
 * @throws {Error} When a seed insert returns no row.
 */
async function seedProject(): Promise<{ projectId: string; userId: string; cookie: string }> {
  const tag = `qpr-${String(seq++)}-${crypto.randomBytes(3).toString("hex")}`;
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
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${project!.id}, ${user!.id}, 'owner', null)
  `;
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, user!.id);
  return { projectId: project!.id, userId: user!.id, cookie: `${sessionCookieName()}=${token}` };
}

/**
 * Open chat in a project.
 * @param projectId - The project.
 * @param cookie - The caller's session cookie.
 * @returns The conversation id.
 * @throws {Error} When the endpoint answers with anything but 200.
 */
async function openConversation(projectId: string, cookie: string): Promise<string> {
  const res = await app.request("/api/v1/chat/open", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ project_id: projectId }),
  });
  if (res.status !== 200) throw new Error(`open chat failed: ${String(res.status)}`);
  const body = (await res.json()) as { data: { current: { conversation: { id: string } } } };
  return body.data.current.conversation.id;
}

/** A conversation the cases below talk in. */
interface Chat {
  projectId: string;
  userId: string;
  cookie: string;
  conversationId: string;
}

/**
 * A fresh project and conversation.
 * @returns Its ids and cookie.
 */
async function newChat(): Promise<Chat> {
  const seeded = await seedProject();
  return { ...seeded, conversationId: await openConversation(seeded.projectId, seeded.cookie) };
}

/**
 * Post to `/chat/message` and read the whole answer.
 * @param chat - Where.
 * @param body - What, beyond the conversation and project.
 * @returns The status, the stream's chunks when it streamed, and the body otherwise.
 */
async function post(
  chat: Chat,
  body: Record<string, unknown>,
): Promise<{ status: number; chunks: Array<Record<string, unknown>>; json: Record<string, unknown> | null }> {
  const res = await app.request("/api/v1/chat/message", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: chat.cookie },
    body: JSON.stringify({ project_id: chat.projectId, conversation_id: chat.conversationId, ...body }),
  });
  const text = await res.text();
  if (res.headers.get("content-type")?.includes("text/event-stream") !== true) {
    return { status: res.status, chunks: [], json: text ? (JSON.parse(text) as Record<string, unknown>) : null };
  }
  const chunks = text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
  return { status: res.status, chunks, json: null };
}

/**
 * The model calling `ask_user`, once or more in one step.
 * @param ids - The call ids, in order.
 * @returns One model call's parts.
 */
function asking(...ids: string[]): ModelStreamPart[] {
  return [
    ...ids.map(
      (toolCallId): ModelStreamPart => ({
        type: "tool-call",
        toolCallId,
        toolName: "ask_user",
        input: JSON.stringify(QUESTIONS),
      }),
    ),
    FINISHED_ASKING_FOR_A_TOOL,
  ];
}

/**
 * Every stored row of a conversation, oldest first.
 * @param conversationId - The conversation.
 * @returns The rows.
 */
async function storedRows(conversationId: string): Promise<StoredRow[]> {
  return sql<StoredRow[]>`
    SELECT role, turn_index, seq, parts, for_model
    FROM conversation_messages
    WHERE conversation_id = ${conversationId} AND deleted_at IS NULL
    ORDER BY turn_index ASC, seq ASC
  `;
}

/**
 * The stored `ask_user` part with this id.
 * @param rows - The conversation's rows.
 * @param toolCallId - The call.
 * @returns The part.
 * @throws {Error} When no row holds it.
 */
function askPart(rows: StoredRow[], toolCallId: string): Record<string, unknown> {
  for (const row of rows) {
    const part = row.parts.find((p) => p.type === "tool" && p.toolCallId === toolCallId);
    if (part) return part;
  }
  throw new Error(`no stored part for ${toolCallId}`);
}

/**
 * Every part of every message the model was handed on one call.
 * @param call - Which call, counting from the end.
 * @returns The parts, in order.
 */
function promptParts(call = -1): Array<Record<string, unknown>> {
  const prompt = (model.calls.at(call)?.prompt ?? []) as Array<{ role: string; content: unknown }>;
  return prompt.flatMap((m) =>
    Array.isArray(m.content)
      ? (m.content as Array<Record<string, unknown>>).map((part) => ({ ...part, role: m.role }))
      : [{ type: "text", text: m.content, role: m.role }],
  );
}

/**
 * Ask in a fresh conversation and return it with the asking call's id.
 * @param id - The call id the model uses.
 * @returns The conversation.
 */
async function askedIn(id: string): Promise<Chat> {
  const chat = await newChat();
  model.queue = [asking(id)];
  model.calls = [];
  const first = await post(chat, { message: "make me a poster" });
  expect(first.status).toBe(200);
  return chat;
}

/** A valid answer to `QUESTIONS`. */
const ANSWERS = [
  { index: 0, selected: ["9:16"] },
  { index: 1, selected: [], other: "Calm" },
];

describe("a turn that asks", () => {
  it("stops at the card, stores the call as awaiting and says so on the wire", async () => {
    const chat = await newChat();
    model.queue = [asking("ask-1")];
    model.calls = [];
    const { status, chunks } = await post(chat, { message: "make me a poster" });

    expect(status).toBe(200);
    expect(model.calls).toHaveLength(1);
    expect(chunks).toContainEqual(expect.objectContaining({ type: "data-ask-awaiting", data: { toolCallId: "ask-1" } }));
    expect(chunks.some((c) => c.type === "data-blocked")).toBe(false);
    const rows = await storedRows(chat.conversationId);
    expect(askPart(rows, "ask-1")).toMatchObject({ toolName: "ask_user", status: "awaiting" });
  });

  it("keeps the first of two questions in one step and turns the second away, with a result for it in what is replayed", async () => {
    const chat = await newChat();
    model.queue = [asking("ask-a", "ask-b")];
    model.calls = [];
    const { chunks } = await post(chat, { message: "make me a poster" });

    expect(chunks).toContainEqual(expect.objectContaining({ type: "data-ask-awaiting", data: { toolCallId: "ask-a" } }));
    const rows = await storedRows(chat.conversationId);
    expect(askPart(rows, "ask-a")).toMatchObject({ status: "awaiting" });
    expect(askPart(rows, "ask-b")).toMatchObject({ status: "error", failure: { kind: "turned_away" } });
    const reply = rows.find((r) => r.role === "assistant")!;
    const results = (reply.for_model?.messages ?? []).flatMap((m) =>
      Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : [],
    );
    expect(results.filter((p) => p.type === "tool-result").map((p) => p.toolCallId)).toEqual(["ask-b"]);
  });
});

describe("answering on the card", () => {
  it("resumes the same turn: the result goes to the model, nothing new is said for the reader, and the call is answered in its own row", async () => {
    const chat = await askedIn("ask-2");
    model.calls = [];
    const { status, chunks } = await post(chat, { message: "", answer: { toolCallId: "ask-2", answers: ANSWERS } });

    expect(status).toBe(200);
    const firstOutput = chunks.findIndex((c) => c.type === "tool-output-available");
    expect(chunks[firstOutput]).toMatchObject({ toolCallId: "ask-2", output: { answers: ANSWERS } });
    expect(firstOutput).toBeLessThan(chunks.findIndex((c) => c.type === "text-delta"));

    const result = promptParts().find((p) => p.type === "tool-result" && p.toolCallId === "ask-2");
    expect(result).toMatchObject({ output: { type: "json", value: { answers: ANSWERS } } });

    const rows = await storedRows(chat.conversationId);
    expect(rows.map((r) => [r.role, r.turn_index])).toEqual([
      ["user", 1],
      ["assistant", 1],
      ["assistant", 1],
    ]);
    expect(askPart(rows, "ask-2")).toMatchObject({ status: "success", output: { answers: ANSWERS } });
    const paused = rows[1]!.for_model!.messages!;
    expect(paused.at(-1)).toMatchObject({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "ask-2", output: { type: "json", value: { answers: ANSWERS } } }],
    });
  });

  it("is taken once: a second answer to the same card is refused before any stream with the call as it stands", async () => {
    const chat = await askedIn("ask-3");
    await post(chat, { message: "", answer: { toolCallId: "ask-3", answers: ANSWERS } });
    model.calls = [];
    const again = await post(chat, {
      message: "",
      answer: { toolCallId: "ask-3", answers: [{ index: 0, selected: ["16:9"] }] },
    });

    expect(again.status).toBe(409);
    expect(again.json).toMatchObject({ error: { code: 409 }, call: { status: "success", output: { answers: ANSWERS } } });
    expect(model.calls).toHaveLength(0);
  });

  it("refuses answers that do not fit the questions, and the card keeps waiting", async () => {
    const chat = await askedIn("ask-4");
    const res = await post(chat, { message: "", answer: { toolCallId: "ask-4", answers: [{ index: 0, selected: ["4:3"] }] } });

    expect(res.status).toBe(422);
    expect(askPart(await storedRows(chat.conversationId), "ask-4")).toMatchObject({ status: "awaiting" });
  });

  it("charges the resumed segment under a key of its own", async () => {
    const chat = await askedIn("ask-5");
    await post(chat, { message: "", answer: { toolCallId: "ask-5", answers: ANSWERS } });

    const keys = await sql<{ operation_key: string }[]>`
      SELECT DISTINCT operation_key FROM agent_usage_records WHERE actor_user_id = ${chat.userId}
    `;
    expect(keys.map((k) => k.operation_key).sort()).toEqual(
      [`turn:${chat.conversationId}:1`, `turn:${chat.conversationId}:1:answer:ask-5`].sort(),
    );
  });

  it("leaves a conversation every later request can still send", async () => {
    const chat = await askedIn("ask-6");
    await post(chat, { message: "", answer: { toolCallId: "ask-6", answers: ANSWERS } });
    model.calls = [];
    const next = await post(chat, { message: "thanks, now a second one" });

    expect(next.status).toBe(200);
    expect(model.calls).toHaveLength(1);
    const parts = promptParts();
    expect(parts.filter((p) => p.type === "tool-call" && p.toolCallId === "ask-6")).toHaveLength(1);
    expect(parts.filter((p) => p.type === "tool-result" && p.toolCallId === "ask-6")).toHaveLength(1);
  });
});

describe("writing a message instead", () => {
  it("is an ordinary message, and the waiting call gets a neutral result in the row that asked", async () => {
    const chat = await askedIn("ask-7");
    model.calls = [];
    const { status, chunks } = await post(chat, { message: "1. 9:16 2. calm" });

    expect(status).toBe(200);
    expect(chunks).toContainEqual(expect.objectContaining({ type: "data-ask-replied", data: { toolCallId: "ask-7" } }));
    const rows = await storedRows(chat.conversationId);
    expect(rows.map((r) => [r.role, r.turn_index])).toEqual([
      ["user", 1],
      ["assistant", 1],
      ["user", 2],
      ["assistant", 2],
    ]);
    expect(askPart(rows, "ask-7")).toMatchObject({ status: "success", output: { repliedInChat: true } });
    expect(rows[1]!.for_model!.messages!.at(-1)).toMatchObject({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "ask-7", output: { type: "json", value: { repliedInChat: true } } }],
    });
    const parts = promptParts();
    const resultAt = parts.findIndex((p) => p.type === "tool-result" && p.toolCallId === "ask-7");
    const saidAt = parts.findIndex((p) => p.role === "user" && typeof p.text === "string" && p.text.includes("1. 9:16 2. calm"));
    expect(resultAt).toBeGreaterThanOrEqual(0);
    expect(resultAt).toBeLessThan(saidAt);
  });

  it("closes the card, so an answer arriving after it is refused", async () => {
    const chat = await askedIn("ask-8");
    await post(chat, { message: "never mind, something else" });
    const late = await post(chat, { message: "", answer: { toolCallId: "ask-8", answers: ANSWERS } });

    expect(late.status).toBe(409);
    expect(late.json).toMatchObject({ call: { status: "success", output: { repliedInChat: true } } });
  });
});

describe("answers racing each other", () => {
  it("take effect once however many arrive together", async () => {
    const chat = await askedIn("ask-9");
    const results = await Promise.all(
      Array.from({ length: 5 }, () => post(chat, { message: "", answer: { toolCallId: "ask-9", answers: ANSWERS } })),
    );

    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409]);
    const rows = await storedRows(chat.conversationId);
    expect(rows.filter((r) => r.role === "assistant")).toHaveLength(2);
  });

  it("close the card exactly once whatever mix of answers and messages arrives together", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.constantFrom("answer", "message"), { minLength: 1, maxLength: 4 }), async (ops) => {
        const id = `ask-p-${crypto.randomBytes(4).toString("hex")}`;
        const chat = await askedIn(id);
        const results = await Promise.all(
          ops.map((op) =>
            op === "answer"
              ? post(chat, { message: "", answer: { toolCallId: id, answers: ANSWERS } })
              : post(chat, { message: "something" }),
          ),
        );
        const answered = results.filter((r, i) => ops[i] === "answer" && r.status === 200).length;
        const replied = results.filter((r) =>
          r.chunks.some((c) => c.type === "data-ask-replied" && (c.data as { toolCallId?: string }).toolCallId === id),
        ).length;
        expect(answered + replied).toBe(1);
        const part = askPart(await storedRows(chat.conversationId), id);
        expect(part.status).toBe("success");
      }),
      { numRuns: 8 },
    );
  }, 120_000);
});
