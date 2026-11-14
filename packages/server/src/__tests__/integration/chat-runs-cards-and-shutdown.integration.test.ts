// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A card's answer, a deleted conversation and a shutdown, through the chat
 * routes on a real Redis and database (inner#1717).
 *
 * A card's answer resumes the run that asked and answers as JSON; its refusals
 * carry what the page needs in the error envelope. A shutdown stops every run:
 * one already running is stored as failed with reason `shutdown`, and a card's
 * run the flag catches before it runs still leaves that ending, so the user
 * sees the turn failed and can carry on; a sync opens no run meanwhile.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, inject, vi } from "vitest";

const script = vi.hoisted(() => ({
  calls: [] as Array<() => unknown[]>,
  hold: undefined as Promise<void> | undefined,
  count: 0,
}));

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  const { assemblyProvider, fakeProvider } = await import("../helpers/fake-provider.js");
  actual.initProvider(assemblyProvider());
  const { MockLanguageModelV4 } = await import("ai/test");
  const { FINISHED } = await import("../helpers/model-double.js");
  return {
    ...actual,
    provider: fakeProvider(() =>
      new MockLanguageModelV4({
        doStream: async (asked) => {
          const i = script.count++;
          if (script.hold !== undefined) await script.hold;
          const parts = (script.calls[i] ?? (() => [
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "done" },
            { type: "text-end", id: "t" },
            FINISHED,
          ]))();
          return {
            stream: new ReadableStream({
              start(controller) {
                for (const p of parts) controller.enqueue(p as never);
                if (asked.abortSignal?.aborted === true) controller.close();
                else controller.close();
              },
            }),
          };
        },
      })),
  };
});

import type * as DomainModule from "@breatic/domain";
import crypto from "node:crypto";
import postgres from "postgres";
import { getRedis, initCore, loadLocales, env } from "@breatic/core";
import type { Hono } from "hono";
import { FINISHED_ASKING_FOR_A_TOOL } from "../helpers/model-double.js";
import { markShuttingDown, resetShutdownFlagForTests } from "@server/agent/shutdown-flag.js";
import { attach, keysOf, seedOwner, send, sync, until, untilIdle, type Seeded, turnFrames } from "./chat-run-harness.js";

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  try {
    initCore(process.env);
  } catch {
    // Already initialised by a sibling suite in this worker.
  }
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 6, prepare: false });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

afterEach(() => {
  resetShutdownFlagForTests();
  script.calls = [];
  script.hold = undefined;
  script.count = 0;
});

const QUESTIONS = {
  questions: [{ header: "Ratio", question: "Which ratio?", options: [{ label: "16:9" }, { label: "9:16" }] }],
};
const ANSWERS = [{ index: 0, selected: ["9:16"] }];

/**
 * The model asking with one card.
 * @param toolCallId - The call's id.
 * @returns The call's parts.
 */
const asking = (toolCallId: string) => (): unknown[] => [
  { type: "tool-call", toolCallId, toolName: "ask_user", input: JSON.stringify(QUESTIONS) },
  FINISHED_ASKING_FOR_A_TOOL,
];

/**
 * A conversation whose run stopped at a card.
 * @param toolCallId - The card's call id.
 * @returns The conversation.
 */
async function stoppedAtCard(toolCallId: string): Promise<Seeded> {
  const who = await seedOwner(sql, app);
  script.calls = [asking(toolCallId)];
  await send(app, who, { message: "ask me" });
  await untilIdle(who.conversationId);
  expect(await getRedis().get(keysOf(who.conversationId).awaiting)).toBe(toolCallId);
  return who;
}

/**
 * Answer the card.
 * @param who - Whose conversation.
 * @param toolCallId - The card's call id.
 * @param headers - Extra headers.
 * @returns The response.
 */
async function answer(who: Seeded, toolCallId: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.request("/api/v1/chat/message", {
    method: "POST",
    headers: { Cookie: who.cookie, "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      message: "",
      project_id: who.projectId,
      conversation_id: who.conversationId,
      answer: { toolCallId, answers: ANSWERS },
    }),
  });
}

/**
 * The stored rows of a conversation.
 * @param c - The conversation.
 * @returns Each row's role and parts, in order.
 */
async function rowsOf(c: string): Promise<Array<{ role: string; parts: Array<Record<string, unknown>> }>> {
  return sql`SELECT role, parts FROM conversation_messages WHERE conversation_id = ${c} AND deleted_at IS NULL ORDER BY turn_index, seq`;
}

describe("answering a card", () => {
  it("resumes the run and answers as JSON (RT-14)", async () => {
    const who = await stoppedAtCard("ask-1");
    const res = await answer(who, "ask-1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ data: { status: "start", pending: [], running: true } });
    await untilIdle(who.conversationId);
  });

  it("carries how the call stands inside the error envelope once it was answered (RT-15)", async () => {
    const who = await stoppedAtCard("ask-2");
    await answer(who, "ask-2");
    await untilIdle(who.conversationId);
    const res = await answer(who, "ask-2");
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: { code: 409, message: expect.any(String), call: { status: "success", output: expect.anything() } } });
    expect("call" in body).toBe(false);
    expect(await getRedis().exists(keysOf(who.conversationId).active)).toBe(0);
  });

  it("answers 404 for a card that is not there (RT-16)", async () => {
    const who = await seedOwner(sql, app);
    expect((await answer(who, "no-such-card")).status).toBe(404);
  });

  it("hands the conversation back with its card still waiting when the answer is refused (RT-19b)", async () => {
    const who = await stoppedAtCard("ask-5");
    expect((await answer(who, "not-this-card")).status).toBe(404);
    expect(await getRedis().exists(keysOf(who.conversationId).active)).toBe(0);
    expect(await getRedis().get(keysOf(who.conversationId).awaiting)).toBe("ask-5");
    const card = (await rowsOf(who.conversationId)).flatMap((r) => r.parts).find((p) => p.toolCallId === "ask-5");
    expect(card?.status).toBe("awaiting");
  });

  it("answers turn_busy and leaves the card waiting when a run holds the conversation (RT-19)", async () => {
    const who = await stoppedAtCard("ask-3");
    await getRedis().set(keysOf(who.conversationId).active, "R-other");
    const res = await answer(who, "ask-3");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error).toEqual({ code: 409, message: expect.any(String), reason: "turn_busy" });
    const card = (await rowsOf(who.conversationId)).flatMap((r) => r.parts).find((p) => p.toolCallId === "ask-3");
    expect(card?.status).toBe("awaiting");
    expect(await getRedis().get(keysOf(who.conversationId).active)).toBe("R-other");
    await getRedis().del(keysOf(who.conversationId).active);
  });
});

describe("a shutdown", () => {
  it("refuses a card's answer before taking it (SD-07, RT-20)", async () => {
    const who = await stoppedAtCard("ask-4");
    markShuttingDown();
    const res = await answer(who, "ask-4", { "Accept-Language": "ja" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error).toEqual({ code: 503, message: expect.any(String), reason: "shutting_down" });
    expect(body.error.message).not.toMatch(/restarting/);
    expect(await getRedis().get(keysOf(who.conversationId).awaiting)).toBe("ask-4");
    const card = (await rowsOf(who.conversationId)).flatMap((r) => r.parts).find((p) => p.toolCallId === "ask-4");
    expect(card?.status).toBe("awaiting");
  });

  it("opens no run from a sync (SD-06)", async () => {
    const who = await seedOwner(sql, app);
    const id = crypto.randomUUID();
    await getRedis().rpush(
      keysOf(who.conversationId).queue,
      JSON.stringify({ id, sentAt: new Date().toISOString(), userId: who.userId, acceptLanguage: "en", message: "waiting", attached_chips: [] }),
    );
    markShuttingDown();
    const body = (await (await sync(app, who)).json()) as { data: { running: boolean; pending: Array<{ id: string }> } };
    expect(body.data.running).toBe(false);
    expect(body.data.pending.map((p) => p.id)).toEqual([id]);
    expect(await getRedis().exists(keysOf(who.conversationId).active)).toBe(0);
  });

  it("stores a running run as failed for the shutdown and keeps what waits (SD-04, ST-10)", async () => {
    const who = await seedOwner(sql, app);
    let release!: () => void;
    script.hold = new Promise((r) => {
      release = r;
    });
    await send(app, who, { message: "first" });
    await until(() => script.count >= 1);
    const waiting = crypto.randomUUID();
    await send(app, who, { id: waiting, message: "next" });
    const reading = attach(app, who);
    await new Promise((r) => setTimeout(r, 50));
    markShuttingDown();
    release();
    const { frames } = await reading;
    const types = turnFrames(frames).map((f) => f.type);
    expect(frames.find((f) => f.type === "data-failed")).toEqual({ type: "data-failed", data: { reason: "shutdown" } });
    expect(types.indexOf("data-failed")).toBeLessThan(types.indexOf("error"));
    expect(types).not.toContain("data-next-run");
    await untilIdle(who.conversationId);
    const reply = (await rowsOf(who.conversationId)).find((r) => r.role === "assistant");
    expect(reply?.parts).toContainEqual({ type: "failed", reason: "shutdown" });
    expect(reply?.parts.some((p) => p.type === "interrupted")).toBe(false);
    expect((await getRedis().lrange(keysOf(who.conversationId).queue, 0, -1)).length).toBe(1);
  });
});

describe("deleting a conversation", () => {
  it("clears its queue and stops its run, and opens no next run (RT-26)", async () => {
    const who = await seedOwner(sql, app);
    let release!: () => void;
    script.hold = new Promise((r) => {
      release = r;
    });
    await send(app, who, { message: "first" });
    await until(() => script.count >= 1);
    await send(app, who, { message: "queued" });
    const reading = attach(app, who);
    await new Promise((r) => setTimeout(r, 50));
    const res = await app.request(`/api/v1/chat/conversations/${who.conversationId}`, { method: "DELETE", headers: { Cookie: who.cookie } });
    expect(res.status).toBe(200);
    for (const key of Object.values(keysOf(who.conversationId))) {
      if (key === keysOf(who.conversationId).active) continue;
      expect(await getRedis().exists(key)).toBe(0);
    }
    release();
    const { frames } = await reading;
    expect(frames.some((f) => f.type === "data-interrupted")).toBe(true);
    expect(frames.some((f) => f.type === "data-next-run")).toBe(false);
    await until(async () => (await getRedis().exists(keysOf(who.conversationId).active)) === 0);
  });
});

describe("the running list's member (#1394)", () => {
  it("is the conversation and the run (LS-09)", async () => {
    const who = await seedOwner(sql, app);
    let release!: () => void;
    script.hold = new Promise((r) => {
      release = r;
    });
    await send(app, who, { message: "first" });
    const runId = await getRedis().get(keysOf(who.conversationId).active);
    const key = `${env.REDIS_KEY_PREFIX}:server:chat-running:${who.userId}:${who.projectId}`;
    expect(await getRedis().zrange(key, 0, -1)).toEqual([`${who.conversationId}:${runId}`]);
    release();
    await untilIdle(who.conversationId);
  });
});
