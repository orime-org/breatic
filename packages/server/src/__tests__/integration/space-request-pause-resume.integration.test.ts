// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A Space request pauses the turn, and the reader's answer resumes it
 * (inner#1552).
 *
 * `request_space_content` waits for the reader the way `ask_user` does: the
 * segment that asked stops, the call is stored as `awaiting`, and the answer
 * comes back on `/chat/message` as `shared_spaces` -- the Spaces the browser
 * read, or a refusal -- or as word that the reader wrote a message instead.
 * The card keeps a summary per Space; the model's copy keeps the content.
 *
 * The model is a double, and everything else is real: the route, the turn,
 * the store and the SDK's own conversion of what is replayed. Storage reads
 * of transfer files go through a stub, as in the transfer suites.
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
import postgres from "postgres";
import { initCore, loadLocales, getAgentConfig, getStorageAdapter, ObjectTooLarge } from "@breatic/core";
import { attachmentSection, SPACE_NAME_MAX_LEN, type ChatAttachedChip } from "@breatic/shared";
import type { Hono } from "hono";
import { SECOND_QUESTION_TURNED_AWAY } from "@server/agent/ask-result.js";
import { FINISHED_ASKING_FOR_A_TOOL } from "../helpers/model-double.js";
import type { ModelStreamPart } from "../helpers/model-double.js";
import {
  enc,
  post as postRaw,
  ref,
  seedProject,
  transferConfig,
  transferGrant,
  type Seeded,
} from "./transfer-fixtures.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

let sql: ReturnType<typeof postgres>;
let app: Hono;
/** The storage read as it was before this file stubbed it. */
let realRead: ((key: string, maxBytes: number) => Promise<Uint8Array>) | undefined;
/** What the stubbed storage read hands back. */
const stored = { file: new Uint8Array() };

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), { max: 8, prepare: false });
  const { createApp } = await import("@server/app.js");
  app = createApp();
  const adapter = await getStorageAdapter();
  realRead = adapter.read.bind(adapter);
  // A real adapter refuses a file over the cap it is asked to read within.
  adapter.read = async (key: string, maxBytes: number): Promise<Uint8Array> => {
    if (stored.file.length > maxBytes) throw new ObjectTooLarge(key);
    return stored.file;
  };
});

afterAll(async () => {
  if (realRead !== undefined) (await getStorageAdapter()).read = realRead;
  await sql?.end({ timeout: 1 });
});

/** The configured caps this feature reads. */
function caps(): { maxSpaces: number; maxNodeIds: number; maxChars: number; readTimeoutMs: number } {
  const config = getAgentConfig() as unknown as {
    space_request_max_spaces: number;
    space_request_max_node_ids: number;
    space_read_timeout_ms: number;
    current_space_max_chars: number;
  };
  return {
    maxSpaces: config.space_request_max_spaces,
    maxNodeIds: config.space_request_max_node_ids,
    maxChars: config.current_space_max_chars,
    readTimeoutMs: config.space_read_timeout_ms,
  };
}

/** A stored message row, as the assertions read it. */
interface StoredRow {
  role: string;
  turn_index: number;
  seq: number;
  parts: Array<Record<string, unknown>>;
  for_model: { messages?: Array<Record<string, unknown>> } | null;
}

/** Every canvas reduction at zero. */
const WHOLE = {
  selected_total: 0,
  selected_attached: 0,
  selected_whole: 0,
  slim: false,
  texts_cut: 0,
  names_only: 0,
  edges_not_listed: 0,
  nodes_not_listed: 0,
  groups_not_listed: 0,
};

/** The project's Spaces as the browser lists them on every message. */
const DOC = { id: crypto.randomUUID(), name: "Script", kind: "document" as const };
const CANVAS = { id: crypto.randomUUID(), name: "Cast", kind: "canvas" as const };
const SPACES = [DOC, CANVAS];

/** The request the model makes in these cases. */
const REQUEST = { reason: "To read the cast list.", spaces: [{ id: CANVAS.id }, { id: DOC.id, blocks: { from: 2, to: 3 } }] };

/** What the browser read of each. */
const READ_CANVAS = { ...CANVAS, state: "read", content: "THE CAST LIST: Ada, Ben", total_chars: 23, detail: WHOLE };
const READ_DOC = { ...DOC, state: "read", part: { blocks: { from: 2, to: 3 } }, content: "<!-- b:2 -->\nSCENE TWO", total_chars: 21, blocks_total: 7 };

/** What the card keeps of that. */
const SUMMARY = {
  spaces: [
    { id: CANVAS.id, name: "Cast", kind: "canvas", state: "read" },
    { id: DOC.id, name: "Script", kind: "document", part: { blocks: { from: 2, to: 3 } }, state: "read" },
  ],
};

/** A conversation the cases below talk in. */
interface Chat extends Seeded {
  conversationId: string;
}

/**
 * A fresh project and conversation.
 * @returns Its ids and A's cookie.
 * @throws {Error} When opening chat answers with anything but 200.
 */
async function newChat(): Promise<Chat> {
  const seeded = await seedProject(sql);
  const res = await app.request("/api/v1/chat/open", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: seeded.a.cookie },
    body: JSON.stringify({ project_id: seeded.projectId }),
  });
  if (res.status !== 200) throw new Error(`open chat failed: ${String(res.status)}`);
  const body = (await res.json()) as { data: { current: { conversation: { id: string } } } };
  return { ...seeded, conversationId: body.data.current.conversation.id };
}

/** What a post answered. */
interface Answered {
  status: number;
  chunks: Array<Record<string, unknown>>;
  json: Record<string, unknown> | null;
}

/**
 * Read a response: the stream's chunks when it streamed, the body otherwise.
 * @param res - The response.
 * @returns What it said.
 */
async function read(res: Response): Promise<Answered> {
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
 * Post to `/chat/message` as A, with the Space list every message carries.
 * @param chat - Where.
 * @param body - What, beyond the conversation, project and Space list.
 * @returns What it answered.
 */
async function post(chat: Chat, body: Record<string, unknown>): Promise<Answered> {
  const res = await app.request("/api/v1/chat/message", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: chat.a.cookie },
    body: JSON.stringify({
      project_id: chat.projectId,
      conversation_id: chat.conversationId,
      spaces: SPACES,
      spaces_total: SPACES.length,
      ...body,
    }),
  });
  return read(res);
}

/**
 * One model call making these tool calls in one step.
 * @param calls - Each call's id, tool and arguments.
 * @returns The call's parts.
 */
function calling(...calls: Array<{ id: string; tool: string; input: unknown }>): ModelStreamPart[] {
  return [
    ...calls.map(
      (call): ModelStreamPart => ({ type: "tool-call", toolCallId: call.id, toolName: call.tool, input: JSON.stringify(call.input) }),
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
 * The stored tool part with this id.
 * @param rows - The conversation's rows.
 * @param toolCallId - The call.
 * @returns The part.
 * @throws {Error} When no row holds it.
 */
function partOf(rows: StoredRow[], toolCallId: string): Record<string, unknown> {
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
 * The model asks to read Spaces in a fresh conversation.
 * @param id - The call id.
 * @param input - The request; `REQUEST` by default.
 * @returns The conversation.
 */
async function requestedIn(id: string, input: unknown = REQUEST): Promise<Chat> {
  const chat = await newChat();
  model.queue = [calling({ id, tool: "request_space_content", input })];
  model.calls = [];
  const first = await post(chat, { message: "who is in the cast?" });
  expect(first.status).toBe(200);
  return chat;
}

/**
 * The shared answer for a call.
 * @param toolCallId - The call.
 * @param spaces - What the browser read; both requested Spaces by default.
 * @returns The `shared_spaces` field.
 */
function shared(toolCallId: string, spaces: unknown[] = [READ_CANVAS, READ_DOC]): Record<string, unknown> {
  return { toolCallId, decision: "shared", spaces };
}

describe("a turn that asks to read Spaces", () => {
  it("stops at the card, stores the call as awaiting and says so on the wire", async () => {
    const chat = await newChat();
    model.queue = [calling({ id: "req-1", tool: "request_space_content", input: REQUEST })];
    model.calls = [];
    const { status, chunks } = await post(chat, { message: "who is in the cast?" });

    expect(status).toBe(200);
    expect(model.calls).toHaveLength(1);
    expect(chunks).toContainEqual(expect.objectContaining({ type: "data-ask-awaiting", data: { toolCallId: "req-1" } }));
    expect(partOf(await storedRows(chat.conversationId), "req-1")).toMatchObject({
      toolName: "request_space_content",
      status: "awaiting",
      input: REQUEST,
    });
  });

  it("keeps the first card of a step whichever tool put it, and turns the other away under its own name", async () => {
    const chat = await newChat();
    const questions = { questions: [{ header: "Ratio", question: "Which ratio?", options: [{ label: "16:9" }, { label: "9:16" }] }] };
    model.queue = [
      calling({ id: "ask-a", tool: "ask_user", input: questions }, { id: "req-b", tool: "request_space_content", input: REQUEST }),
    ];
    model.calls = [];
    const { chunks } = await post(chat, { message: "who is in the cast?" });

    expect(chunks).toContainEqual(expect.objectContaining({ type: "data-ask-awaiting", data: { toolCallId: "ask-a" } }));
    const rows = await storedRows(chat.conversationId);
    expect(partOf(rows, "ask-a")).toMatchObject({ status: "awaiting" });
    expect(partOf(rows, "req-b")).toMatchObject({
      status: "error",
      failure: { kind: "turned_away", forModel: SECOND_QUESTION_TURNED_AWAY },
    });
    const reply = rows.find((r) => r.role === "assistant")!;
    const results = (reply.for_model?.messages ?? [])
      .flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : []))
      .filter((p) => p.type === "tool-result");
    expect(results.map((p) => [p.toolCallId, p.toolName])).toEqual([["req-b", "request_space_content"]]);
  });

  it("is still a waiting card when the conversation is opened again", async () => {
    const chat = await requestedIn("req-reload");
    const res = await app.request(`/api/v1/chat/conversations/${chat.conversationId}`, { headers: { Cookie: chat.a.cookie } });
    expect(res.status).toBe(200);
    const said = JSON.stringify(((await res.json()) as { data: { messages: unknown } }).data.messages);
    expect(said).toContain(JSON.stringify({ type: "data-ask-awaiting", data: { toolCallId: "req-reload" } }));
  });
});

describe("sharing the Spaces on the card", () => {
  it("resumes the same turn: the model reads the content, the browser and the card only the summary", async () => {
    const chat = await requestedIn("req-2");
    model.calls = [];
    const { status, chunks } = await post(chat, { message: "", shared_spaces: shared("req-2") });

    expect(status).toBe(200);
    const firstOutput = chunks.findIndex((c) => c.type === "tool-output-available");
    expect(chunks[firstOutput]).toEqual({ type: "tool-output-available", toolCallId: "req-2", output: SUMMARY });
    expect(firstOutput).toBeLessThan(chunks.findIndex((c) => c.type === "text-delta"));
    expect(JSON.stringify(chunks)).not.toContain("THE CAST LIST");

    const result = promptParts().find((p) => p.type === "tool-result" && p.toolCallId === "req-2");
    expect(result).toMatchObject({
      toolName: "request_space_content",
      output: { type: "json", value: { spaces: [READ_CANVAS, READ_DOC] } },
    });

    const rows = await storedRows(chat.conversationId);
    expect(rows.map((r) => [r.role, r.turn_index])).toEqual([
      ["user", 1],
      ["assistant", 1],
      ["assistant", 1],
    ]);
    const part = partOf(rows, "req-2");
    expect(part).toMatchObject({ status: "success", output: SUMMARY });
    expect(JSON.stringify(part)).not.toContain("THE CAST LIST");
    expect(rows[1]!.for_model!.messages!.at(-1)).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "req-2",
          toolName: "request_space_content",
          output: { type: "json", value: { spaces: [READ_CANVAS, READ_DOC] } },
        },
      ],
    });
  });

  it("keeps the content in what every later request sends the model", async () => {
    const chat = await requestedIn("req-3");
    await post(chat, { message: "", shared_spaces: shared("req-3") });
    model.calls = [];
    const next = await post(chat, { message: "and who plays the lead?" });

    expect(next.status).toBe(200);
    expect(model.calls).toHaveLength(1);
    const parts = promptParts();
    expect(parts.filter((p) => p.type === "tool-call" && p.toolCallId === "req-3")).toHaveLength(1);
    const result = parts.find((p) => p.type === "tool-result" && p.toolCallId === "req-3");
    expect(JSON.stringify(result)).toContain("THE CAST LIST: Ada, Ben");
  });

  it("is taken once: a second answer is refused before any stream, with the call as it stands", async () => {
    const chat = await requestedIn("req-4");
    await post(chat, { message: "", shared_spaces: shared("req-4") });
    model.calls = [];
    const again = await post(chat, { message: "", shared_spaces: { toolCallId: "req-4", decision: "declined" } });

    expect(again.status).toBe(409);
    expect(again.json).toMatchObject({ error: { code: 409 }, call: { status: "success", output: SUMMARY } });
    expect(model.calls).toHaveLength(0);
  });

  it("is refused for a call that was turned away, which stands as an error", async () => {
    const chat = await newChat();
    const questions = { questions: [{ header: "Ratio", question: "Which ratio?", options: [{ label: "16:9" }, { label: "9:16" }] }] };
    model.queue = [
      calling({ id: "ask-first", tool: "ask_user", input: questions }, { id: "req-away", tool: "request_space_content", input: REQUEST }),
    ];
    await post(chat, { message: "who is in the cast?" });
    model.calls = [];
    const late = await post(chat, { message: "", shared_spaces: shared("req-away") });

    expect(late.status).toBe(409);
    expect(late.json).toMatchObject({ error: { code: 409 }, call: { status: "error" } });
    expect(model.calls).toHaveLength(0);
  });

  it("refuses Spaces that are not the ones asked for, and the card keeps waiting", async () => {
    const chat = await requestedIn("req-5");
    const stranger = { ...READ_CANVAS, id: crypto.randomUUID() };
    const res = await post(chat, { message: "", shared_spaces: shared("req-5", [stranger, READ_DOC]) });

    expect(res.status).toBe(422);
    expect(partOf(await storedRows(chat.conversationId), "req-5")).toMatchObject({ status: "awaiting" });
  });

  it("refuses a Space whose content is over the open-Space limit, and the card keeps waiting", async () => {
    const chat = await requestedIn("req-6");
    const { maxChars } = caps();
    const long = { ...READ_CANVAS, content: "x".repeat(maxChars + 1), total_chars: maxChars + 1 };
    const res = await post(chat, { message: "", shared_spaces: shared("req-6", [long, READ_DOC]) });

    expect(res.status).toBe(422);
    expect(partOf(await storedRows(chat.conversationId), "req-6")).toMatchObject({ status: "awaiting" });
  });

  it("answers 404 for a call that is not in the conversation", async () => {
    const chat = await requestedIn("req-7");
    const res = await post(chat, { message: "", shared_spaces: shared("req-nowhere") });

    expect(res.status).toBe(404);
  });
});

describe("declining on the card", () => {
  it("resumes the same turn with the model told it was declined", async () => {
    const chat = await requestedIn("req-8");
    model.calls = [];
    const { status, chunks } = await post(chat, { message: "", shared_spaces: { toolCallId: "req-8", decision: "declined" } });

    expect(status).toBe(200);
    expect(chunks.find((c) => c.type === "tool-output-available")).toEqual({
      type: "tool-output-available",
      toolCallId: "req-8",
      output: { declined: true },
    });
    const result = promptParts().find((p) => p.type === "tool-result" && p.toolCallId === "req-8");
    expect(result).toMatchObject({ toolName: "request_space_content", output: { type: "json", value: { declined: true } } });
    expect(partOf(await storedRows(chat.conversationId), "req-8")).toMatchObject({ status: "success", output: { declined: true } });
  });
});

describe("writing a message instead", () => {
  it("closes the card, filed under the request's own tool in the row that asked", async () => {
    const chat = await requestedIn("req-9");
    model.calls = [];
    const { status, chunks } = await post(chat, { message: "never mind, just guess" });

    expect(status).toBe(200);
    expect(chunks).toContainEqual(expect.objectContaining({ type: "data-ask-replied", data: { toolCallId: "req-9" } }));
    const rows = await storedRows(chat.conversationId);
    expect(partOf(rows, "req-9")).toMatchObject({ status: "success", output: { repliedInChat: true } });
    expect(rows[1]!.for_model!.messages!.at(-1)).toEqual({
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "req-9", toolName: "request_space_content", output: { type: "json", value: { repliedInChat: true } } },
      ],
    });
    const result = promptParts().find((p) => p.type === "tool-result" && p.toolCallId === "req-9");
    expect(result).toMatchObject({ toolName: "request_space_content", output: { type: "json", value: { repliedInChat: true } } });
  });

  it("leaves a share arriving after it refused", async () => {
    const chat = await requestedIn("req-10");
    await post(chat, { message: "something else" });
    const late = await post(chat, { message: "", shared_spaces: shared("req-10") });

    expect(late.status).toBe(409);
    expect(late.json).toMatchObject({ call: { status: "success", output: { repliedInChat: true } } });
  });
});

describe("the knobs the browser reads", () => {
  it("include how long a read may take", async () => {
    const chat = await newChat();
    const res = await app.request("/api/v1/chat/stream-config", { headers: { Cookie: chat.a.cookie } });
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    const { readTimeoutMs } = caps();

    expect(readTimeoutMs).toBe(20000);
    expect(data).toMatchObject({ spaceReadTimeoutMs: readTimeoutMs });
  });
});

describe("the largest answer a browser can send", () => {
  it("fits the chat route's transfer cap, every field at its limit in characters JSON escapes to six bytes", async () => {
    const { maxSpaces, maxNodeIds, maxChars } = caps();
    const config = getAgentConfig();
    // U+0001 is written by JSON.stringify as `\u0001`: six bytes for one character.
    const worst = (n: number): string => "\u0001".repeat(n);

    const requested = Array.from({ length: maxSpaces }, () => ({
      id: crypto.randomUUID(),
      name: worst(SPACE_NAME_MAX_LEN),
      kind: "canvas" as const,
      nodeIds: Array.from({ length: maxNodeIds }, () => crypto.randomUUID()),
    }));
    const listed = [
      ...requested.map(({ id, name, kind }) => ({ id, name, kind })),
      ...Array.from({ length: config.space_list_max_items - requested.length }, () => ({
        id: crypto.randomUUID(),
        name: worst(SPACE_NAME_MAX_LEN),
        kind: "document" as const,
      })),
    ];
    const open = listed[maxSpaces]!;
    // Attachments too: the schema lets an answering request carry them, so the
    // cap has to hold them beside everything else. Their limit is measured on
    // the section, which already escapes the text, so the most bytes per
    // measured character there is a three-byte character JSON leaves alone.
    const wide = (n: number): string => "\u4e2d".repeat(n);
    const chip: ChatAttachedChip = { id: "file-1", type: "text", name: wide(255), data_snapshot: { text: "" } };
    const room = config.attachment_max_chars - attachmentSection([chip]).length;
    const chips = [{ ...chip, data_snapshot: { text: wide(room) } }];
    expect(attachmentSection(chips).length).toBeLessThanOrEqual(config.attachment_max_chars);

    const chat = await newChat();
    model.queue = [
      calling({
        id: "req-max",
        tool: "request_space_content",
        input: { reason: "To read them all.", spaces: requested.map(({ id, nodeIds }) => ({ id, node_ids: nodeIds })) },
      }),
    ];
    const asked = await read(
      await app.request("/api/v1/chat/message", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: chat.a.cookie },
        body: JSON.stringify({
          project_id: chat.projectId,
          conversation_id: chat.conversationId,
          message: "read them all",
          spaces: listed,
          spaces_total: listed.length,
        }),
      }),
    );
    expect(asked.chunks).toContainEqual(expect.objectContaining({ type: "data-ask-awaiting", data: { toolCallId: "req-max" } }));

    const body = {
      message: "",
      project_id: chat.projectId,
      conversation_id: chat.conversationId,
      attached_chips: chips,
      spaces: listed,
      spaces_total: listed.length,
      current_space: {
        ...open,
        state: "loaded",
        content: worst(maxChars),
        total_chars: maxChars,
        blocks: [{ id: crypto.randomUUID(), type: "paragraph", text: worst(maxChars), lossy: false, partial: false }],
      },
      shared_spaces: {
        toolCallId: "req-max",
        decision: "shared",
        spaces: requested.map(({ id, name, kind, nodeIds }) => ({
          id,
          name,
          kind,
          state: "read",
          part: { node_ids: nodeIds },
          content: worst(maxChars),
          total_chars: maxChars,
          detail: WHOLE,
          nodes_missing: 0,
        })),
      },
    };
    const file = enc(body);
    expect(file.length).toBeLessThanOrEqual(transferConfig().route_max_bytes.chat_message);

    const key = await transferGrant({ userId: chat.a.id, studioId: chat.studioId, projectId: chat.projectId, declaredSize: file.length });
    stored.file = file;
    model.calls = [];
    const res = await read(await postRaw(app, "/chat/message", chat.a.cookie, ref(key)));

    expect(res.status).toBe(200);
    expect(res.chunks.find((c) => c.type === "tool-output-available")).toMatchObject({ toolCallId: "req-max" });
    expect(model.calls).toHaveLength(1);
  }, 120_000);
});
