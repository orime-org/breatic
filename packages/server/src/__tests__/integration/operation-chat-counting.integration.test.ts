// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * How Agent messages are counted, through the real chat routes and runs, on
 * real Postgres and Redis with payments on (inner#1968, test spec area B:
 * B-24 to B-28, B-36, B-37, B-51, B-52, B-63, B-70 for the chat entry, B-73
 * to B-76).
 *
 * Every new message is one operation, `chat:<userId>:<messageId>`, admitted
 * when it is accepted and counted in the transaction that stores the run's
 * reply, for the opening message and each one the run took in; unless the
 * run ended `failed` or `too_long`, which release them. A stopped run and a
 * run that stopped at a card still count. Answering a card is not a new
 * message. Derived images the message carries (a node's focus crops, a 3D
 * screenshot) are claimed by it and used up when it counts.
 *
 * The model is a scripted double; everything else is real.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, inject, vi } from "vitest";

/** What the model does on each call, in order; a short reply when the script is empty. */
const model = vi.hoisted(() => ({
  script: [] as Array<{ kind: "parts"; parts: unknown[] } | { kind: "fail"; error: () => Error } | { kind: "hold"; until: Promise<void> } | { kind: "open" }>,
  calls: 0,
}));

/** Failures a case injects into the queue. */
const queueFault = vi.hoisted(() => ({ enqueueThrows: 0 }));

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  const { assemblyProvider, fakeProvider } = await import("../helpers/fake-provider.js");
  actual.initProvider(assemblyProvider());
  const { MockLanguageModelV4 } = await import("ai/test");
  const { saying } = await import("../helpers/model-double.js");
  return {
    ...actual,
    provider: fakeProvider(() =>
      new MockLanguageModelV4({
        doStream: async (asked) => {
          model.calls += 1;
          const step = model.script.shift() ?? { kind: "parts", parts: saying("ok") };
          if (step.kind === "fail") throw step.error();
          if (step.kind === "hold") await step.until;
          const parts = step.kind === "parts" ? step.parts : saying("ok").slice(0, 2);
          return {
            stream: new ReadableStream({
              start(controller) {
                for (const part of parts) controller.enqueue(part as never);
                if (step.kind !== "open" || asked.abortSignal?.aborted === true) controller.close();
                else asked.abortSignal?.addEventListener("abort", () => controller.close());
              },
            }),
          };
        },
      })),
  };
});

vi.mock("@server/modules/chat-queue/chat-queue.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof QueueModule>();
  return {
    ...actual,
    chatQueue: () => {
      const real = actual.chatQueue();
      return {
        ...real,
        enqueue: async (...args: Parameters<typeof real.enqueue>) => {
          if (queueFault.enqueueThrows > 0) {
            queueFault.enqueueThrows -= 1;
            throw new Error("injected enqueue failure");
          }
          return real.enqueue(...args);
        },
      };
    },
  };
});

vi.mock("@breatic/shared", async (importOriginal) =>
  (await import("../helpers/ingest-open-double.js")).sharedWithOpenDouble(importOriginal),
);

import type * as DomainModule from "@breatic/domain";
import type * as QueueModule from "@server/modules/chat-queue/chat-queue.service.js";
import crypto from "node:crypto";
import postgres from "postgres";
import type { Hono } from "hono";
import { db, getRedis, initCore, loadLocales } from "@breatic/core";
import { operationService } from "@breatic/domain";
import { FINISHED_ASKING_FOR_A_TOOL, saying } from "../helpers/model-double.js";
import { h1 } from "../helpers/overflow-turn.js";
import { keysOf, sendAndRead, stop, until, untilIdle } from "./chat-run-harness.js";
import {
  PAYMENTS_ON,
  derivedUpload,
  ledgerRow,
  ledgerRows,
  request,
  seedAccount,
  stored,
  ticket,
  used,
  type Account,
  type Derived,
} from "./operation-counting-fixtures.js";

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  initCore(PAYMENTS_ON);
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 6, prepare: false, connection: { application_name: "operation-chat-counting-test" } });
  app = (await import("@server/app.js")).createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  initCore(process.env);
});

beforeEach(() => {
  model.script = [];
  model.calls = 0;
  queueFault.enqueueThrows = 0;
});

/** The standard account with its project's conversation open. */
interface Chat extends Account {
  conversationId: string;
}

/**
 * The standard account and an open conversation.
 * @returns The chat.
 */
async function newChat(): Promise<Chat> {
  const a = await seedAccount(sql);
  const opened = await request(app, a.cookie, "POST", "/chat/open", { project_id: a.projectId });
  const conversationId = ((await opened.json()) as { data: { current: { conversation: { id: string } } } }).data.current.conversation.id;
  return { ...a, conversationId };
}

/**
 * Send one message (or a card's answer) and read the run it opens to its end.
 * @param chat - Where.
 * @param body - What, beyond the conversation and project.
 * @returns The status and the JSON answer.
 */
async function post(chat: Chat, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const id = typeof body.id === "string" ? body.id : undefined;
  const sent = await sendAndRead(app, chat.cookie, { project_id: chat.projectId, conversation_id: chat.conversationId, ...body }, id === undefined ? {} : { "Idempotency-Key": id });
  return { status: sent.status, json: sent.json };
}

/**
 * Send a new message with a fresh id.
 * @param chat - Where.
 * @param extra - Attachments and the like.
 * @param id - Its id; fresh by default.
 * @returns Its ledger key and the answer.
 */
async function say(chat: Chat, extra: Record<string, unknown> = {}, id: string = crypto.randomUUID()): Promise<{ key: string; status: number; json: Record<string, unknown> | null }> {
  const sent = await post(chat, { id, message: "make me a poster", ...extra });
  return { key: `chat:${chat.userId}:${id}`, ...sent };
}

/**
 * A canvas piece attached to a message, one node per crop, each crop in its node's focus images.
 * @param crops - The crops, in order.
 * @returns The chip.
 */
function canvasChip(crops: Derived[]): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    type: "canvas",
    name: "Canvas",
    data_snapshot: {
      nodes: crops.map((crop) => ({ id: crypto.randomUUID(), type: "generation", data: { focusImages: [{ id: crypto.randomUUID(), url: crop.url, name: "crop" }] } })),
      edges: [],
    },
  };
}

/**
 * The model calling a tool that waits for the user.
 * @param toolCallId - The call id.
 * @param toolName - The tool.
 * @param input - Its input.
 * @returns One model call.
 */
function calling(toolCallId: string, toolName: string, input: unknown): { kind: "parts"; parts: unknown[] } {
  return { kind: "parts", parts: [{ type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) }, FINISHED_ASKING_FOR_A_TOOL] };
}

/**
 * Forget every run-once answer the account's requests left, as a day passing would.
 * @param chat - Whose.
 */
async function forgetRunOnce(chat: Chat): Promise<void> {
  const keys = await getRedis().keys(`*:server:idempotency:${chat.userId}:*`);
  if (keys.length > 0) await getRedis().del(...keys);
}

describe("B.1 each message is one operation", () => {
  it("B-24 two attached files and the message are three operations, all counted", async () => {
    const chat = await newChat();
    const attached = [];
    for (const [type, reported] of [["image", "image/png"], ["video", "video/mp4"]] as const) {
      const t = await ticket(app, chat, { derived: true, ...(type === "video" ? { filename: "clip.mp4", content_type: "video/mp4" } : {}) });
      expect(t.res.status).toBe(201);
      await stored(t.storageKey!, reported);
      attached.push({ key: t.key, chip: { id: crypto.randomUUID(), type, name: type, data_snapshot: { url: `https://assets.example.test/${t.storageKey!}` } } });
    }
    const message = await say(chat, { attached_chips: attached.map((x) => x.chip) });
    expect(message.status).toBe(200);
    for (const key of [...attached.map((x) => x.key), message.key]) expect((await ledgerRow(sql, key))?.status).toBe("counted");
    expect((await ledgerRow(sql, message.key))?.kind).toBe("chat_message");
    expect(await used(chat)).toBe(3);
  });

  it("B-25 the opening message and two sent while the run works are counted when the reply is stored", async () => {
    const chat = await newChat();
    let release!: () => void;
    model.script = [{ kind: "hold", until: new Promise<void>((resolve) => { release = resolve; }) }];
    const first = say(chat);
    await until(() => model.calls > 0);
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    for (const id of ids) {
      const res = await request(app, chat.cookie, "POST", "/chat/message", { id, message: "also this", project_id: chat.projectId, conversation_id: chat.conversationId }, { "Idempotency-Key": id });
      expect(res.status).toBe(200);
    }
    release();
    const opened = await first;
    await untilIdle(chat.conversationId);
    for (const key of [opened.key, ...ids.map((id) => `chat:${chat.userId}:${id}`)]) expect((await ledgerRow(sql, key))?.status).toBe("counted");
    expect(await used(chat)).toBe(3);
  });

  it("B-26 a run the user stops keeps its reply and its message counts", async () => {
    const chat = await newChat();
    model.script = [{ kind: "open" }];
    const sending = say(chat);
    await until(() => model.calls > 0);
    expect((await stop(app, chat)).status).toBe(200);
    const sent = await sending;
    const replies = await sql`select 1 from conversation_messages where conversation_id = ${chat.conversationId} and role = 'assistant'`;
    expect(replies.length).toBeGreaterThan(0);
    expect((await ledgerRow(sql, sent.key))?.status).toBe("counted");
    expect(await used(chat)).toBe(1);
  });

  it("B-27 a run that stops at a questionnaire counts its message", async () => {
    const chat = await newChat();
    model.script = [calling("ask-1", "ask_user", { questions: [{ header: "Ratio", question: "Which ratio?", options: [{ label: "16:9" }, { label: "9:16" }] }] })];
    const sent = await say(chat);
    expect((await ledgerRow(sql, sent.key))?.status).toBe("counted");
    expect(await used(chat)).toBe(1);
  });

  it("B-28 a run that fails, and a run too long to fit, release their messages", async () => {
    const chat = await newChat();
    model.script = [{ kind: "fail", error: () => new Error("upstream down") }];
    const failed = await say(chat);
    const other = await newChat();
    model.script = [{ kind: "fail", error: h1 }];
    const tooLong = await say(other);
    expect((await ledgerRow(sql, failed.key))?.status).toBe("released");
    expect((await ledgerRow(sql, tooLong.key))?.status).toBe("released");
    expect(await used(chat)).toBe(0);
    expect(await used(other)).toBe(0);
  });
});

describe("B.2 answering a card is not a new operation", () => {
  it("B-36 answering a questionnaire adds no row, and the run it resumes counts nothing more", async () => {
    const chat = await newChat();
    model.script = [calling("ask-2", "ask_user", { questions: [{ header: "Ratio", question: "Which ratio?", options: [{ label: "16:9" }, { label: "9:16" }] }] })];
    await say(chat);
    const before = await ledgerRows(sql, chat);
    expect(before).toHaveLength(1);
    model.script = [{ kind: "parts", parts: saying("done") }];
    const answered = await post(chat, { message: "", answer: { toolCallId: "ask-2", answers: [{ index: 0, selected: ["9:16"] }] } });
    expect(answered.status).toBe(200);
    expect((await ledgerRows(sql, chat)).map((r) => r.operation_key)).toEqual(before.map((r) => r.operation_key));
    expect(await used(chat)).toBe(1);
  });

  it("B-37 answering a Space request adds no row", async () => {
    const chat = await newChat();
    const doc = { id: crypto.randomUUID(), name: "Script", kind: "document" as const };
    const spaces = { spaces: [doc], spaces_total: 1 };
    model.script = [calling("req-1", "request_space_content", { reason: "To read the script.", spaces: [{ id: doc.id }] })];
    await say(chat, spaces);
    const before = await ledgerRows(sql, chat);
    expect(before).toHaveLength(1);
    model.script = [{ kind: "parts", parts: saying("done") }];
    await post(chat, { message: "", ...spaces, shared_spaces: { toolCallId: "req-1", decision: "declined" } });
    expect((await ledgerRows(sql, chat)).map((r) => r.operation_key)).toEqual(before.map((r) => r.operation_key));
    expect(await used(chat)).toBe(1);
  });
});

describe("B.3 derived images a message carries", () => {
  it("B-51 a node's focus crop attached to the Agent is used up when the message counts", async () => {
    const chat = await newChat();
    const crop = await derivedUpload(app, sql, chat);
    const sent = await say(chat, { attached_chips: [canvasChip([crop])] });
    expect((await ledgerRow(sql, sent.key))?.status).toBe("counted");
    expect(await ledgerRow(sql, crop.key)).toMatchObject({ status: "released", release_reason: "absorbed" });
    expect(await used(chat)).toBe(1);
  });

  it("B-52 a 3D viewfinder screenshot sent as an image attachment is used up", async () => {
    const chat = await newChat();
    const shot = await derivedUpload(app, sql, chat);
    await say(chat, { attached_chips: [{ id: crypto.randomUUID(), type: "image", name: "Viewfinder", data_snapshot: { url: shot.url } }] });
    expect(await ledgerRow(sql, shot.key)).toMatchObject({ status: "released", release_reason: "absorbed" });
  });

  it("B-63 of fifteen crops in one message only the first ten are used up; the rest count when they expire", async () => {
    const chat = await newChat();
    const crops: Derived[] = [];
    for (let i = 0; i < 15; i++) crops.push(await derivedUpload(app, sql, chat));
    const sent = await say(chat, { attached_chips: [canvasChip(crops)] });
    const message = await ledgerRow(sql, sent.key);
    expect(message?.status).toBe("counted");
    expect(message?.input_asset_ids).toHaveLength(10);
    for (const crop of crops.slice(0, 10)) expect(await ledgerRow(sql, crop.key)).toMatchObject({ status: "released", release_reason: "absorbed" });
    for (const crop of crops.slice(10)) expect((await ledgerRow(sql, crop.key))?.status).toBe("deferred");
    await sql`update operation_ledger set expires_at = now() - interval '1 second' where operation_key in ${sql(crops.slice(10).map((c) => c.key))}`;
    await operationService.sweepDeferredOperations();
    for (const crop of crops.slice(10)) expect((await ledgerRow(sql, crop.key))?.status).toBe("counted");
    expect(await used(chat)).toBe(6);
  });
});

describe("B.4 the same message id again", () => {
  /**
   * Mark a run as holding the conversation, so sends queue without starting one.
   * @param chat - Whose conversation.
   */
  async function busy(chat: Chat): Promise<void> {
    await getRedis().set(keysOf(chat.conversationId).active, "R-running");
  }

  /**
   * Send a message and return the raw response, without reading a run.
   * @param chat - Where.
   * @param id - The message id, also its Idempotency-Key.
   * @returns The response.
   */
  function sendRaw(chat: Chat, id: string): Promise<Response> {
    return request(app, chat.cookie, "POST", "/chat/message", { id, message: "hello", project_id: chat.projectId, conversation_id: chat.conversationId }, { "Idempotency-Key": id });
  }

  it("B-70 a message without an Idempotency-Key is refused as request_shape", async () => {
    const chat = await newChat();
    const res = await request(app, chat.cookie, "POST", "/chat/message", { id: crypto.randomUUID(), message: "hello", project_id: chat.projectId, conversation_id: chat.conversationId }, { "Idempotency-Key": null });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { reason?: string } }).error.reason).toBe("request_shape");
    expect(await ledgerRows(sql, chat)).toEqual([]);
  });

  it("B-73 a send whose enqueue throws is replayed as the same failure, its row released; a new press counts once", async () => {
    const chat = await newChat();
    await busy(chat);
    queueFault.enqueueThrows = 1;
    const m1 = crypto.randomUUID();
    const first = await sendRaw(chat, m1);
    expect(first.status).toBeGreaterThanOrEqual(500);
    const again = await sendRaw(chat, m1);
    expect(again.status).toBe(first.status);
    expect((await ledgerRow(sql, `chat:${chat.userId}:${m1}`))?.status).toBe("released");
    const m2 = crypto.randomUUID();
    expect((await sendRaw(chat, m2)).status).toBe(200);
    expect(await getRedis().sismember(keysOf(chat.conversationId).ids, m2)).toBe(1);
    expect((await ledgerRows(sql, chat)).filter((r) => r.operation_key === `chat:${chat.userId}:${m2}`)).toHaveLength(1);
    await getRedis().del(...Object.values(keysOf(chat.conversationId)));
  });

  it("B-74 a counted message sent again after the run-once answer is forgotten is a duplicate: no new run, nothing counted", async () => {
    const chat = await newChat();
    const sent = await say(chat);
    expect((await ledgerRow(sql, sent.key))?.status).toBe("counted");
    await forgetRunOnce(chat);
    const calls = model.calls;
    const again = await sendRaw(chat, sent.key.split(":").at(-1)!);
    expect(((await again.json()) as { data: { status: string } }).data.status).toBe("duplicate");
    await untilIdle(chat.conversationId);
    expect(model.calls).toBe(calls);
    expect(await used(chat)).toBe(1);
  });

  it("B-75 a message admitted but never queued (a crash between) is queued by its resend and counted once", async () => {
    const chat = await newChat();
    const id = crypto.randomUUID();
    const key = `chat:${chat.userId}:${id}`;
    await operationService.admitOperation({ kind: "chat_message", key, projectId: chat.projectId, actorUserId: chat.userId, inputs: [] });
    await say(chat, {}, id);
    expect((await ledgerRow(sql, key))?.status).toBe("counted");
    expect((await ledgerRows(sql, chat)).filter((r) => r.operation_key === key)).toHaveLength(1);
    expect(await used(chat)).toBe(1);
  });

  it("B-76 a message whose row was released is admitted again on resend and counted", async () => {
    const chat = await newChat();
    const id = crypto.randomUUID();
    const key = `chat:${chat.userId}:${id}`;
    await operationService.admitOperation({ kind: "chat_message", key, projectId: chat.projectId, actorUserId: chat.userId, inputs: [] });
    await db.transaction((tx) => operationService.releaseOperation(key, tx));
    await say(chat, {}, id);
    expect((await ledgerRow(sql, key))?.status).toBe("counted");
    expect(await used(chat)).toBe(1);
  });
});
