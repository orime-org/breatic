// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * How each way into a run opens it, on a real Redis and database (inner#1717).
 *
 * A send, a sync, the end of the run before and a card's answer each open a
 * run whose opening stage checks the conversation's owner may still run it,
 * takes what waits and writes the opening row before the request that opened
 * it answers. A check that refuses decides what happens to what waits: a
 * conversation that is gone or a sender no longer an editor clears it, a
 * balance that cannot pay keeps it for the next sync, and an error nobody
 * expected keeps it too. A shutdown before the running stage leaves what a
 * message run took for the next process, and a card's run its failed ending,
 * wherever in the card's opening it lands.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, inject, vi } from "vitest";

const script = vi.hoisted(() => ({
  calls: [] as Array<() => unknown[]>,
  hold: undefined as Promise<void> | undefined,
  count: 0,
  prompts: [] as unknown[],
  locales: [] as string[],
}));

/** Hooks into the opening stage's checks and a card's answer; each pass-through by default. */
const gate = vi.hoisted(() => ({
  writable: undefined as undefined | ((n: number) => Promise<void> | void),
  writableCalls: 0,
  credits: undefined as undefined | ((n: number) => Promise<void> | void),
  creditCalls: 0,
  take: undefined as undefined | ((stage: "before" | "after") => void),
  addUser: undefined as undefined | (() => Promise<void> | void),
}));

/** The runs that took a place in the running list, in order. */
const leases = vi.hoisted(() => ({ held: [] as string[] }));

vi.mock("@server/modules/conversation/running-turns.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RunningTurnsModule>();
  return {
    ...actual,
    holdRunning: async (...args: Parameters<typeof actual.holdRunning>) => {
      leases.held.push(args[0].runId);
      return actual.holdRunning(...args);
    },
  };
});

/** The error log, watched; every other level goes to the real logger. */
const logged = vi.hoisted(() => ({ error: [] as unknown[][] }));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  const real = actual.logger as unknown as Record<string | symbol, unknown>;
  const logger = new Proxy<Record<string | symbol, unknown>>({}, {
    get(_target, prop) {
      if (prop === "error") {
        return (...args: unknown[]) => {
          logged.error.push(args);
          (real.error as (...a: unknown[]) => void)(...args);
        };
      }
      return real[prop];
    },
  });
  return { ...actual, logger };
});

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  const { assemblyProvider, fakeProvider } = await import("../helpers/fake-provider.js");
  actual.initProvider(assemblyProvider());
  const { MockLanguageModelV4 } = await import("ai/test");
  const { FINISHED } = await import("../helpers/model-double.js");
  const { getActiveLocale } = await import("@breatic/shared");
  return {
    ...actual,
    provider: fakeProvider(() =>
      new MockLanguageModelV4({
        doStream: async (asked) => {
          const i = script.count++;
          script.prompts.push(asked.prompt);
          script.locales.push(getActiveLocale());
          if (script.hold !== undefined) {
            await Promise.race([
              script.hold,
              new Promise<void>((resolve) => asked.abortSignal?.addEventListener("abort", () => resolve())),
            ]);
          }
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
                controller.close();
              },
            }),
          };
        },
      })),
  };
});

vi.mock("@server/modules", async (importOriginal) => {
  const actual = await importOriginal<typeof ModulesModule>();
  const real = actual.conversationService;
  return {
    ...actual,
    conversationService: {
      ...real,
      assertWritable: async (...args: Parameters<typeof real.assertWritable>) => {
        const n = gate.writableCalls++;
        await gate.writable?.(n);
        return real.assertWritable(...args);
      },
      answerAsk: async (...args: Parameters<typeof real.answerAsk>) => {
        gate.take?.("before");
        const taken = await real.answerAsk(...args);
        gate.take?.("after");
        return taken;
      },
      answerSpaceRequest: async (...args: Parameters<typeof real.answerSpaceRequest>) => {
        gate.take?.("before");
        const taken = await real.answerSpaceRequest(...args);
        gate.take?.("after");
        return taken;
      },
    },
    precheckCredits: async (...args: Parameters<typeof actual.precheckCredits>) => {
      const n = gate.creditCalls++;
      await gate.credits?.(n);
      return actual.precheckCredits(...args);
    },
  };
});

vi.mock("@server/modules/conversation/conversation-message.repo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof MessageRepoModule>();
  return {
    ...actual,
    takenStatus: vi.fn(actual.takenStatus),
    addUserMessage: async (...args: Parameters<typeof actual.addUserMessage>) => {
      await gate.addUser?.();
      return actual.addUserMessage(...args);
    },
  };
});

import type * as CoreModule from "@breatic/core";
import type * as RunningTurnsModule from "@server/modules/conversation/running-turns.service.js";
import type * as DomainModule from "@breatic/domain";
import type * as ModulesModule from "@server/modules";
import type * as MessageRepoModule from "@server/modules/conversation/conversation-message.repo.js";
import crypto from "node:crypto";
import postgres from "postgres";
import { AppError, env, getRedis, initCore, loadLocales, NotFoundError, sessionCookieName, setSession } from "@breatic/core";
import type { Hono } from "hono";
import { FINISHED_ASKING_FOR_A_TOOL } from "../helpers/model-double.js";
import { runObservers, startRun, stopChannel } from "@server/agent/chat-run.js";
import { markShuttingDown, resetShutdownFlagForTests } from "@server/agent/shutdown-flag.js";
import { chatQueue } from "@server/modules/chat-queue/chat-queue.service.js";
import * as messageRepo from "@server/modules/conversation/conversation-message.repo.js";
import { pendingAfterReply, settleAfterReply } from "@server/utils/after-reply.js";
import { runStreams } from "@server/agent/run-stream.js";
import { attach, keysOf, seedOwner, send, stop, sync, until, untilIdle, type Seeded, turnFrames } from "./chat-run-harness.js";

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
  vi.restoreAllMocks();
  script.calls = [];
  script.hold = undefined;
  script.count = 0;
  script.prompts = [];
  script.locales = [];
  gate.writable = undefined;
  gate.writableCalls = 0;
  gate.credits = undefined;
  gate.creditCalls = 0;
  gate.take = undefined;
  gate.addUser = undefined;
  logged.error = [];
  leases.held = [];
});

/**
 * A promise and the function that settles it.
 * @returns Both.
 */
function held(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * A queue item as a send stores it.
 * @param who - Whose conversation.
 * @param id - Its id.
 * @param extra - Fields beyond the defaults.
 * @returns The item as Redis holds it.
 */
function itemOf(who: Seeded, id: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id,
    sentAt: new Date().toISOString(),
    userId: who.userId,
    acceptLanguage: "en",
    message: `message ${id.slice(0, 4)}`,
    attached_chips: [],
    ...extra,
  });
}

/**
 * The stored rows of a conversation.
 * @param c - The conversation.
 * @returns Each row's id, role, turn and parts, in order.
 */
async function rowsOf(c: string): Promise<Array<{ id: string; role: string; turn_index: number; parts: Array<Record<string, unknown>> }>> {
  return sql`SELECT id, role, turn_index, parts FROM conversation_messages WHERE conversation_id = ${c} AND deleted_at IS NULL ORDER BY turn_index, seq`;
}

/**
 * The key a run's stream keeps its sentinel under.
 * @param runId - The run.
 * @returns The key.
 */
function sentinelKey(runId: string): string {
  return `${env.REDIS_KEY_PREFIX}:chat-stream:rs:sentinel:${runId}`;
}

/**
 * The running list of an owner in a project.
 * @param who - Whose.
 * @returns The members.
 */
async function runningMembers(who: Seeded): Promise<string[]> {
  return getRedis().zrange(`${env.REDIS_KEY_PREFIX}:server:chat-running:${who.userId}:${who.projectId}`, 0, -1);
}

/**
 * Whether none of a conversation's five keys exists.
 * @param c - The conversation.
 * @returns True when all are gone.
 */
async function keysGone(c: string): Promise<boolean> {
  return (await getRedis().exists(...Object.values(keysOf(c)))) === 0;
}


/**
 * A first run held at its model call with a second message queued behind it,
 * then stopped, so the end of the first run opens a run for the second.
 * Assert calls so far: the first send, its run, the second send and the
 * stop, so the next run's is index 4. Credit checks so far: the first send,
 * its run and the second send, so the next run's is index 3.
 * @param who - Whose conversation.
 * @param second - The second send's extra fields and headers.
 * @param beforeStop - Runs once the second message is queued, before the stop.
 * @returns The second message's id, and the first run's frames read to its end.
 */
async function stoppedWithOneWaiting(
  who: Seeded,
  second: { body?: Record<string, unknown>; headers?: Record<string, string> } = {},
  beforeStop: () => Promise<void> | void = () => {},
): Promise<{ m2: string; reading: Promise<{ status: number; frames: Array<Record<string, unknown>> }> }> {
  const model = held();
  script.hold = model.promise;
  await send(app, who, { message: "first" });
  await until(() => script.count >= 1);
  const m2 = crypto.randomUUID();
  const queued = await send(app, who, { id: m2, message: "second", ...second.body }, second.headers);
  expect(((await queued.json()) as { data: { status: string } }).data.status).toBe("queued");
  const reading = attach(app, who);
  await new Promise((r) => setTimeout(r, 50));
  await beforeStop();
  script.hold = undefined;
  expect(await (await stop(app, who)).json()).toEqual({ data: { stopped: true } });
  void reading.finally(() => model.release());
  return { m2, reading };
}

/**
 * The ids in one of a conversation's lists.
 * @param key - The list.
 * @returns The ids, in order.
 */
async function idsIn(key: string): Promise<string[]> {
  return (await getRedis().lrange(key, 0, -1)).map((raw) => (JSON.parse(raw) as { id: string }).id);
}

/** The two kinds of card, each asked by the model and answered on `/chat/message`. */
const CARDS = [
  {
    kind: "questionnaire",
    asks: (toolCallId: string) => (): unknown[] => [
      {
        type: "tool-call",
        toolCallId,
        toolName: "ask_user",
        input: JSON.stringify({ questions: [{ header: "Ratio", question: "Which ratio?", options: [{ label: "16:9" }, { label: "9:16" }] }] }),
      },
      FINISHED_ASKING_FOR_A_TOOL,
    ],
    answer: (toolCallId: string) => ({ answer: { toolCallId, answers: [{ index: 0, selected: ["9:16"] }] } }),
  },
  {
    kind: "space request",
    asks: (toolCallId: string) => (): unknown[] => [
      {
        type: "tool-call",
        toolCallId,
        toolName: "request_space_content",
        input: JSON.stringify({ reason: "To read the cast list.", spaces: [{ id: SPACE.id }] }),
      },
      FINISHED_ASKING_FOR_A_TOOL,
    ],
    answer: (toolCallId: string) => ({ shared_spaces: { toolCallId, decision: "declined" } }),
  },
] as const;

/** The Space every message lists, so the model may ask to read it. */
const SPACE = { id: crypto.randomUUID(), name: "Cast", kind: "canvas" as const };

/**
 * A conversation whose run stopped at a card.
 * @param card - Which kind.
 * @param toolCallId - The card's call id.
 * @returns The conversation.
 */
async function stoppedAt(card: (typeof CARDS)[number], toolCallId: string): Promise<Seeded> {
  const who = await seedOwner(sql, app);
  script.calls = [card.asks(toolCallId)];
  await send(app, who, { message: "ask me", spaces: [SPACE], spaces_total: 1 });
  await untilIdle(who.conversationId);
  expect(await getRedis().get(keysOf(who.conversationId).awaiting)).toBe(toolCallId);
  script.calls = [];
  script.count = 0;
  script.prompts = [];
  script.locales = [];
  gate.writableCalls = 0;
  gate.creditCalls = 0;
  return who;
}

/**
 * Answer a card.
 * @param who - Whose conversation.
 * @param card - Which kind.
 * @param toolCallId - The card's call id.
 * @param headers - Extra headers.
 * @param extra - Extra body fields.
 * @returns The response.
 */
async function answerCard(
  who: Seeded,
  card: (typeof CARDS)[number],
  toolCallId: string,
  headers: Record<string, string> = {},
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return app.request("/api/v1/chat/message", {
    method: "POST",
    headers: { Cookie: who.cookie, "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      message: "",
      project_id: who.projectId,
      conversation_id: who.conversationId,
      spaces: [SPACE],
      spaces_total: 1,
      ...card.answer(toolCallId),
      ...extra,
    }),
  });
}

/**
 * The status a card's call is stored with.
 * @param c - The conversation.
 * @param toolCallId - The call.
 * @returns Its status.
 */
async function cardStatus(c: string, toolCallId: string): Promise<unknown> {
  return (await rowsOf(c)).flatMap((r) => r.parts).find((p) => p.toolCallId === toolCallId)?.status;
}


/**
 * Attach to a run as soon as its stream exists, and then set the shutdown
 * flag, which the run reads once more before its running stage.
 * @param conversationId - Whose run.
 * @returns The observer, and the run's frames once it ends.
 */
function attachThenShutDown(conversationId: string): {
  observe: (run: { conversationId: string; runId: string }) => Promise<void>;
  frames: () => Promise<Array<Record<string, unknown>>>;
} {
  let text: Promise<string> = Promise.resolve("");
  const observe = async (run: { conversationId: string; runId: string }): Promise<void> => {
    if (run.conversationId !== conversationId) return;
    // Held at once, since the request can answer before the attach resolves.
    const attached = runStreams().resumeExistingStream(run.runId);
    text = attached.then((stream) => (stream ? new Response(stream.pipeThrough(new TextEncoderStream())).text() : ""));
    await attached;
    markShuttingDown();
  };
  const frames = async (): Promise<Array<Record<string, unknown>>> =>
    (await text)
      .split("\n\n")
      .filter((block) => block.startsWith("data: "))
      .map((block) => JSON.parse(block.slice("data: ".length)) as Record<string, unknown>);
  return { observe, frames };
}

describe("a run's opening stage answers only once it is done", () => {
  it("has the opening row stored when a sync answers (SR-02)", async () => {
    const who = await seedOwner(sql, app);
    const id = crypto.randomUUID();
    await getRedis().rpush(keysOf(who.conversationId).queue, itemOf(who, id));
    const model = held();
    script.hold = model.promise;
    const body = (await (await sync(app, who)).json()) as { data: { running: boolean } };
    expect(body.data.running).toBe(true);
    expect((await rowsOf(who.conversationId)).map((r) => r.id)).toContain(id);
    model.release();
    await untilIdle(who.conversationId);
  });

  for (const card of CARDS) {
    it(`has the run's stream and lease in place when a ${card.kind} answer answers (SR-02)`, async () => {
      const id = `card-${card.kind.length}`;
      const who = await stoppedAt(card, id);
      const model = held();
      script.hold = model.promise;
      const res = await answerCard(who, card, id);
      expect(((await res.json()) as { data: { running: boolean } }).data.running).toBe(true);
      const runId = await getRedis().get(keysOf(who.conversationId).active);
      expect(await getRedis().get(sentinelKey(runId!))).toBe("1");
      expect(await runningMembers(who)).toEqual([`${who.conversationId}:${runId}`]);
      model.release();
      await untilIdle(who.conversationId);
    });
  }

  it("is after-reply work from its first line (SR-02b)", async () => {
    const who = await seedOwner(sql, app);
    await getRedis().rpush(keysOf(who.conversationId).queue, itemOf(who, crypto.randomUUID()));
    const claimed = await chatQueue().claim(who.conversationId);
    if (claimed.status !== "start") throw new Error("no run claimed");
    const credits = held();
    gate.credits = () => credits.promise;
    const mine = (): boolean => pendingAfterReply().some((p) => p.conversationId === who.conversationId);
    const { opened } = startRun({
      conversationId: who.conversationId,
      projectId: who.projectId,
      userId: who.userId,
      runId: claimed.runId,
      entrance: { kind: "head" },
    });
    await until(() => gate.creditCalls >= 1);
    expect(mine()).toBe(true);
    credits.release();
    await opened;
    await untilIdle(who.conversationId);
    await until(() => !mine());
  });

  it("writes data-next-run only once the next run's opening is done (SR-03)", async () => {
    const who = await seedOwner(sql, app);
    const opening = held();
    let reached = false;
    gate.writable = (n) => {
      if (n !== 4) return;
      reached = true;
      return opening.promise;
    };
    const { m2, reading } = await stoppedWithOneWaiting(who);
    let done = false;
    void reading.finally(() => {
      done = true;
    });
    await until(() => reached);
    await new Promise((r) => setTimeout(r, 150));
    expect(done).toBe(false);
    expect((await rowsOf(who.conversationId)).map((r) => r.id)).not.toContain(m2);
    opening.release();
    const { frames } = await reading;
    const next = frames.find((f) => f.type === "data-next-run") as { data: { runId: string } } | undefined;
    expect(next).toMatchObject({ type: "data-next-run", transient: true, data: { runId: expect.any(String) } });
    expect((await rowsOf(who.conversationId)).map((r) => r.id)).toContain(m2);
    expect(await getRedis().get(sentinelKey(next!.data.runId))).toBe("1");
    await untilIdle(who.conversationId);
  });
});

describe("a check the opening stage refuses", () => {
  it("clears the conversation's keys when it is gone, and answers 200 with no run (SR-04)", async () => {
    const who = await seedOwner(sql, app);
    const k = keysOf(who.conversationId);
    await getRedis().set(k.awaiting, "T-old");
    await getRedis().rpush(k.taken, itemOf(who, crypto.randomUUID()));
    await getRedis().sadd(k.ids, "x");
    const enqueue = vi.spyOn(chatQueue(), "enqueue");
    gate.writable = (n) => {
      if (n === 1) throw new NotFoundError("gone");
    };
    const res = await send(app, who, { message: "hello" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { status: string; running: boolean } }).data).toMatchObject({ status: "start", running: false });
    const started = (await enqueue.mock.results[0]!.value) as { status: string; runId: string };
    expect(await keysGone(who.conversationId)).toBe(true);
    expect((await rowsOf(who.conversationId)).length).toBe(0);
    expect(await runningMembers(who)).toEqual([]);
    expect(await getRedis().exists(sentinelKey(started.runId))).toBe(0);
  });

  it("clears the conversation's keys when its owner is no longer an editor, and opens nothing after (SR-05)", async () => {
    const owner = await seedOwner(sql, app);
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO users (email, email_verified) VALUES (${`editor-${crypto.randomBytes(4).toString("hex")}@example.com`}, true) RETURNING id
    `;
    const [project] = await sql<{ studio_id: string }[]>`SELECT studio_id FROM projects WHERE id = ${owner.projectId}`;
    await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${project!.studio_id}, ${user!.id}, 'guest')`;
    await sql`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${owner.projectId}, ${user!.id}, 'editor', ${owner.userId})`;
    const token = crypto.randomBytes(24).toString("hex");
    await setSession(getRedis(), token, user!.id);
    const cookie = `${sessionCookieName()}=${token}`;
    const opened = await app.request("/api/v1/chat/open", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: owner.projectId }),
    });
    const conversationId = ((await opened.json()) as { data: { current: { conversation: { id: string } } } }).data.current.conversation.id;
    const who: Seeded = { userId: user!.id, projectId: owner.projectId, conversationId, cookie };

    const opening = held();
    let reached = false;
    gate.writable = (n) => {
      if (n !== 4) return;
      reached = true;
      return opening.promise;
    };
    const { m2, reading } = await stoppedWithOneWaiting(who);
    await until(() => reached);
    await sql`UPDATE project_members SET role = 'viewer' WHERE project_id = ${owner.projectId} AND user_id = ${user!.id}`;
    opening.release();
    const { frames } = await reading;
    expect(frames.some((f) => f.type === "data-next-run")).toBe(false);
    await until(() => keysGone(conversationId));
    expect((await rowsOf(conversationId)).map((r) => r.id)).not.toContain(m2);
    expect((await sync(app, who)).status).toBe(403);
    expect(await getRedis().exists(keysOf(conversationId).active)).toBe(0);
    // The refused run never took a place in the running list (LS-05).
    expect(leases.held).toHaveLength(1);
  });

  it("keeps what waits when the balance cannot pay, for the next sync to report (SR-06)", async () => {
    const who = await seedOwner(sql, app);
    gate.credits = (n) => {
      if (n >= 3) throw new AppError(402, "no credits");
    };
    const { m2, reading } = await stoppedWithOneWaiting(who);
    const { frames } = await reading;
    expect(frames.some((f) => f.type === "data-next-run")).toBe(false);
    await untilIdle(who.conversationId);
    const k = keysOf(who.conversationId);
    expect(await idsIn(k.queue)).toEqual([m2]);
    expect(await getRedis().exists(k.taken)).toBe(0);
    expect((await rowsOf(who.conversationId)).map((r) => r.id)).not.toContain(m2);
    const body = (await (await sync(app, who)).json()) as { data: { blocked?: string; running: boolean } };
    expect(body.data).toMatchObject({ blocked: "credits", running: false });
    // The refused run never took a place in the running list (LS-05).
    expect(leases.held).toHaveLength(1);
  });

  it("refuses a new message whose id already names a message of another conversation, and queues nothing", async () => {
    const other = await seedOwner(sql, app);
    const taken = crypto.randomUUID();
    await messageRepo.addUserMessage(
      other.conversationId,
      { role: "user", parts: [{ type: "text", text: "theirs" }] },
      () => {
        throw new Error("no card waits");
      },
      { messageId: taken },
    );
    const who = await seedOwner(sql, app);
    const res = await send(app, who, { id: taken, message: "hello" });
    expect(res.status).toBe(409);
    const k = keysOf(who.conversationId);
    expect(await getRedis().exists(k.active)).toBe(0);
    expect(await idsIn(k.queue)).toEqual([]);
  });

  it("refuses a new message whose id names a reply in the same conversation, and queues nothing", async () => {
    const who = await seedOwner(sql, app);
    const reply = crypto.randomUUID();
    await messageRepo.addMessage(who.conversationId, { role: "assistant", parts: [{ type: "text", text: "an answer" }], turnIndex: 0 }, undefined, reply);
    const res = await send(app, who, { id: reply, message: "hello" });
    expect(res.status).toBe(409);
    const k = keysOf(who.conversationId);
    expect(await getRedis().exists(k.active)).toBe(0);
    expect(await idsIn(k.queue)).toEqual([]);
  });

  it("leaves no rejection unhandled when the opening row cannot be written, and keeps the message", async () => {
    const who = await seedOwner(sql, app);
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown): void => {
      unhandled.push(err);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      gate.addUser = () => {
        gate.addUser = undefined;
        throw new Error("database write failed");
      };
      const id = crypto.randomUUID();
      await send(app, who, { id, message: "hello" });
      await untilIdle(who.conversationId);
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
      const k = keysOf(who.conversationId);
      expect([...(await idsIn(k.taken)), ...(await idsIn(k.queue))]).toEqual([id]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("keeps what waits and opens no run after an error nobody expected (SR-15)", async () => {
    const who = await seedOwner(sql, app);
    gate.writable = (n) => {
      if (n === 1) throw new Error("database connection lost");
    };
    const id = crypto.randomUUID();
    const res = await send(app, who, { id, message: "hello" });
    expect(((await res.json()) as { data: { status: string; running: boolean } }).data).toMatchObject({ status: "start", running: false });
    const k = keysOf(who.conversationId);
    expect(await getRedis().exists(k.active)).toBe(0);
    expect(await idsIn(k.queue)).toEqual([id]);
    expect(logged.error).toContainEqual([
      expect.objectContaining({ err: expect.objectContaining({ message: "database connection lost" }), conversationId: who.conversationId }),
      expect.any(String),
    ]);
    // The refused run never took a place in the running list (LS-05).
    expect(leases.held).toEqual([]);
  });
});

describe("what a run opens with", () => {
  for (const shape of ["rest", "queue", "empty"] as const) {
    it(`asks the store about every taken id before forgetting any, with ${shape} after the answered one (SR-09c)`, async () => {
      const who = await seedOwner(sql, app);
      const k = keysOf(who.conversationId);
      const answered = crypto.randomUUID();
      const turn = await messageRepo.addUserMessage(
        who.conversationId,
        { role: "user", parts: [{ type: "text", text: "old" }] },
        () => {
          throw new Error("no card waits");
        },
        { messageId: answered },
      );
      await messageRepo.addMessage(who.conversationId, { role: "assistant", turnIndex: turn.turnIndex, parts: [{ type: "text", text: "answered" }] });
      const rest = crypto.randomUUID();
      await getRedis().rpush(k.taken, itemOf(who, answered), ...(shape === "rest" ? [itemOf(who, rest)] : []));
      if (shape === "queue") await getRedis().rpush(k.queue, itemOf(who, rest));
      const q = chatQueue();
      const calls: string[] = [];
      const status = vi.mocked(messageRepo.takenStatus);
      status.mockClear();
      for (const name of ["head", "forget", "ack", "settle"] as const) {
        const real = q[name].bind(q) as (...a: unknown[]) => Promise<unknown>;
        vi.spyOn(q, name).mockImplementation(async (...a: unknown[]) => {
          calls.push(name === "forget" ? `forget after asking ${JSON.stringify(status.mock.calls.at(-1)?.[1])}` : name);
          return real(...a) as never;
        });
      }
      const body = (await (await sync(app, who)).json()) as { data: { running: boolean } };
      await untilIdle(who.conversationId);
      const opening = calls.slice(0, calls.indexOf("settle") === -1 ? undefined : calls.indexOf("settle") + 1);
      expect(opening).toContain(`forget after asking ${JSON.stringify(shape === "rest" ? [answered, rest] : [answered])}`);
      expect(opening.filter((c) => c === "head")).toHaveLength(shape === "rest" ? 1 : 2);
      if (shape === "empty") {
        expect(body.data.running).toBe(false);
        expect(opening.at(-1)).toBe("settle");
        expect(script.count).toBe(0);
        expect(await runningMembers(who)).toEqual([]);
      } else {
        expect(body.data.running).toBe(true);
        expect((await rowsOf(who.conversationId)).map((r) => r.id)).toContain(rest);
      }
    });
  }

  it("opens the next run for a message sent while it found nothing to open with", async () => {
    const who = await seedOwner(sql, app);
    const k = keysOf(who.conversationId);
    const answered = crypto.randomUUID();
    const turn = await messageRepo.addUserMessage(
      who.conversationId,
      { role: "user", parts: [{ type: "text", text: "old" }] },
      () => {
        throw new Error("no card waits");
      },
      { messageId: answered },
    );
    await messageRepo.addMessage(who.conversationId, { role: "assistant", turnIndex: turn.turnIndex, parts: [{ type: "text", text: "answered" }] });
    await getRedis().rpush(k.taken, itemOf(who, answered));
    const late = crypto.randomUUID();
    const q = chatQueue();
    const realSettle = q.settle.bind(q);
    let sent = false;
    vi.spyOn(q, "settle").mockImplementation(async (...a) => {
      // The run found nothing left to open with; a message arrives before it lets go.
      if (!sent) {
        sent = true;
        expect(((await (await send(app, who, { id: late, message: "just now" })).json()) as { data: { status: string } }).data.status).toBe("queued");
      }
      return realSettle(...a);
    });
    await sync(app, who);
    await until(async () => (await rowsOf(who.conversationId)).some((r) => r.id === late), 5000);
    await untilIdle(who.conversationId);
  });

  it("opens with the first message a dead run left taken and takes the rest in at the first step (SR-11)", async () => {
    const who = await seedOwner(sql, app);
    const [a, b, c] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    await getRedis().rpush(
      keysOf(who.conversationId).taken,
      itemOf(who, a, { message: "msg a" }),
      itemOf(who, b, { message: "msg b" }),
      itemOf(who, c, { message: "msg c" }),
    );
    await sync(app, who);
    await untilIdle(who.conversationId);
    const rows = await rowsOf(who.conversationId);
    expect(rows.filter((r) => r.role === "user").map((r) => r.id)).toEqual([a]);
    const reply = rows.find((r) => r.role === "assistant")!;
    expect(reply.parts.filter((p) => p.type === "user-message").map((p) => p.id)).toEqual([b, c]);
    const firstText = reply.parts.findIndex((p) => p.type === "text");
    expect(reply.parts.findIndex((p) => p.type === "user-message" && p.id === c)).toBeLessThan(firstText);
    const said = JSON.stringify(script.prompts[0]);
    expect(said.indexOf("msg a")).toBeLessThan(said.indexOf("msg b"));
    expect(said.indexOf("msg b")).toBeLessThan(said.indexOf("msg c"));
  });

  it("answers a waiting message whose model the deployment stopped listing, on the conversation's model", async () => {
    const who = await seedOwner(sql, app);
    const m = crypto.randomUUID();
    await getRedis().rpush(keysOf(who.conversationId).queue, itemOf(who, m, { message: "still answer me", model: "retired/model" }));
    await sync(app, who);
    await untilIdle(who.conversationId);
    const rows = await rowsOf(who.conversationId);
    expect(rows.filter((r) => r.role === "user").map((r) => r.id)).toEqual([m]);
    expect(rows.some((r) => r.role === "assistant")).toBe(true);
    expect(await getRedis().llen(keysOf(who.conversationId).queue)).toBe(0);
    expect(await getRedis().llen(keysOf(who.conversationId).taken)).toBe(0);
  });

  it("acks the run that ended before the next run opens, so the next one's opening is a new row (SR-16)", async () => {
    const who = await seedOwner(sql, app);
    const order: string[] = [];
    const { m2, reading } = await stoppedWithOneWaiting(who, {}, () => {
      const q = chatQueue();
      for (const name of ["ack", "settle", "head"] as const) {
        const real = q[name].bind(q) as (...a: unknown[]) => Promise<unknown>;
        vi.spyOn(q, name).mockImplementation(async (...a: unknown[]) => {
          if (name === "ack") {
            order.push(`ack with ${String((await rowsOf(who.conversationId)).filter((r) => r.role === "assistant").length)} reply`);
          } else if (name === "head") {
            order.push(`head with ${String(await getRedis().llen(keysOf(who.conversationId).taken))} taken`);
          } else {
            order.push(name);
          }
          return real(...a) as never;
        });
      }
    });
    await reading;
    await untilIdle(who.conversationId);
    expect(order.slice(0, 3)).toEqual(["ack with 1 reply", "settle", "head with 0 taken"]);
    const rows = await rowsOf(who.conversationId);
    const first = rows.find((r) => r.role === "user")!;
    const second = rows.find((r) => r.id === m2)!;
    expect(second.role).toBe("user");
    expect(second.turn_index).toBeGreaterThan(first.turn_index);
  });

  it("opens with what waited longest, and takes the new message in at the first step (SR-17)", async () => {
    const who = await seedOwner(sql, app);
    const m0 = crypto.randomUUID();
    await getRedis().rpush(keysOf(who.conversationId).queue, itemOf(who, m0, { message: "left behind" }));
    const m1 = crypto.randomUUID();
    await send(app, who, { id: m1, message: "just sent" });
    await untilIdle(who.conversationId);
    const rows = await rowsOf(who.conversationId);
    expect(rows.filter((r) => r.role === "user").map((r) => r.id)).toEqual([m0]);
    expect(rows.find((r) => r.role === "assistant")!.parts.filter((p) => p.type === "user-message").map((p) => p.id)).toEqual([m1]);
  });
});

describe("the end of a run with a message waiting", () => {
  it("opens the next run for it after the run failed, and says so on the failed run's stream (PS-07)", async () => {
    const who = await seedOwner(sql, app);
    const model = held();
    script.hold = model.promise;
    script.calls = [() => [{ type: "error", error: new Error("provider down") }]];
    await send(app, who, { message: "first" });
    await until(() => script.count >= 1);
    const m2 = crypto.randomUUID();
    await send(app, who, { id: m2, message: "second" });
    const reading = attach(app, who);
    await new Promise((r) => setTimeout(r, 50));
    script.hold = undefined;
    model.release();
    const { frames } = await reading;
    expect(frames.some((f) => f.type === "data-failed")).toBe(true);
    expect(frames.some((f) => f.type === "data-next-run")).toBe(true);
    await untilIdle(who.conversationId);
    const rows = await rowsOf(who.conversationId);
    expect(rows.find((r) => r.id === m2)?.role).toBe("user");
  });

  it("keeps it waiting while the run stops at a card, and the answer's run takes it in at its first step (PS-08)", async () => {
    const card = CARDS[0];
    const who = await seedOwner(sql, app);
    const model = held();
    script.hold = model.promise;
    script.calls = [card.asks("ps8")];
    await send(app, who, { message: "ask me" });
    await until(() => script.count >= 1);
    const m2 = crypto.randomUUID();
    await send(app, who, { id: m2, message: "by the way" });
    const reading = attach(app, who);
    await new Promise((r) => setTimeout(r, 50));
    script.hold = undefined;
    model.release();
    const { frames } = await reading;
    expect(frames.some((f) => f.type === "data-next-run")).toBe(false);
    await untilIdle(who.conversationId);
    const k = keysOf(who.conversationId);
    expect(await getRedis().get(k.awaiting)).toBe("ps8");
    expect(await idsIn(k.queue)).toEqual([m2]);
    script.calls = [];
    script.count = 0;
    script.prompts = [];
    await answerCard(who, card, "ps8");
    await untilIdle(who.conversationId);
    expect(JSON.stringify(script.prompts[0])).toContain("by the way");
    const reply = (await rowsOf(who.conversationId)).filter((r) => r.role === "assistant").at(-1)!;
    expect(reply.parts.filter((p) => p.type === "user-message").map((p) => p.id)).toEqual([m2]);
    expect(await idsIn(k.queue)).toEqual([]);
  });
});

describe("the context a run runs in", () => {
  it("runs a run the end of the run before opened in the language and time zone its message was sent with (SR-14)", async () => {
    const who = await seedOwner(sql, app);
    const { reading } = await stoppedWithOneWaiting(who, { body: { time_zone: "Asia/Tokyo" }, headers: { "Accept-Language": "ja" } });
    await reading;
    await until(() => script.count >= 2);
    await untilIdle(who.conversationId);
    expect(script.locales[1]).toBe("ja");
    expect(JSON.stringify(script.prompts[1])).toContain("Asia/Tokyo");
  });

  it("runs a card's answer in the language and time zone of the answer's own request (SR-14)", async () => {
    const card = CARDS[0];
    const who = await stoppedAt(card, "card-locale");
    await answerCard(who, card, "card-locale", { "Accept-Language": "ko" }, { time_zone: "Europe/Paris" });
    await until(() => script.count >= 1);
    await untilIdle(who.conversationId);
    expect(script.locales[0]).toBe("ko");
    expect(JSON.stringify(script.prompts[0])).toContain("Europe/Paris");
  });

  it("stops on a stop published from another instance (SR-13)", async () => {
    const who = await seedOwner(sql, app);
    const model = held();
    script.hold = model.promise;
    await send(app, who, { message: "first" });
    await until(() => script.count >= 1);
    const runId = (await getRedis().get(keysOf(who.conversationId).active))!;
    const reading = attach(app, who);
    await new Promise((r) => setTimeout(r, 50));
    const other = getRedis().duplicate();
    try {
      const from = Date.now();
      await other.publish(stopChannel(runId), "stop");
      const { frames } = await reading;
      expect(Date.now() - from).toBeLessThan(1000);
      expect(frames.some((f) => f.type === "data-interrupted")).toBe(true);
    } finally {
      await other.quit();
      model.release();
    }
    await untilIdle(who.conversationId);
    expect((await rowsOf(who.conversationId)).find((r) => r.role === "assistant")?.parts).toContainEqual(
      expect.objectContaining({ type: "interrupted" }),
    );
  });
});

describe("a shutdown before a run's running stage", () => {
  it("opens nothing and keeps what waits when the flag is already set (SD-01)", async () => {
    const who = await seedOwner(sql, app);
    const id = crypto.randomUUID();
    await getRedis().rpush(keysOf(who.conversationId).queue, itemOf(who, id));
    const claimed = await chatQueue().claim(who.conversationId);
    if (claimed.status !== "start") throw new Error("no run claimed");
    const head = vi.spyOn(chatQueue(), "head");
    markShuttingDown();
    const { opened } = startRun({
      conversationId: who.conversationId,
      projectId: who.projectId,
      userId: who.userId,
      runId: claimed.runId,
      entrance: { kind: "head" },
    });
    expect(await opened).toEqual({ running: false });
    expect(gate.writableCalls).toBe(0);
    expect(gate.creditCalls).toBe(0);
    expect(head).not.toHaveBeenCalled();
    expect(await getRedis().exists(keysOf(who.conversationId).active)).toBe(0);
    expect(await idsIn(keysOf(who.conversationId).queue)).toEqual([id]);
    expect(await rowsOf(who.conversationId)).toEqual([]);
    expect(await getRedis().exists(sentinelKey(claimed.runId))).toBe(0);
  });

  for (const entrance of ["send", "sync"] as const) {
    it(`closes a ${entrance}'s run with no frame and keeps its opening taken when the flag is set after the opening (SD-02)`, async () => {
      const who = await seedOwner(sql, app);
      const id = crypto.randomUUID();
      const watch = attachThenShutDown(who.conversationId);
      runObservers.push(watch.observe);
      try {
        if (entrance === "send") {
          await send(app, who, { id, message: "hello" });
        } else {
          await getRedis().rpush(keysOf(who.conversationId).queue, itemOf(who, id));
          await sync(app, who);
        }
        const frames = await watch.frames();
        expect(turnFrames(frames)).toEqual([]);
      } finally {
        runObservers.splice(runObservers.indexOf(watch.observe), 1);
      }
      await untilIdle(who.conversationId);
      expect(script.count).toBe(0);
      expect(await idsIn(keysOf(who.conversationId).taken)).toEqual([id]);
      expect(await idsIn(keysOf(who.conversationId).queue)).toEqual([]);
      expect((await rowsOf(who.conversationId)).filter((r) => r.role === "assistant")).toEqual([]);
    });
  }

  it("frees the conversation before the pools close when SIGTERM lands while the opening is stuck (SD-03)", async () => {
    const who = await seedOwner(sql, app);
    const id = crypto.randomUUID();
    await getRedis().rpush(keysOf(who.conversationId).queue, itemOf(who, id));
    const opening = held();
    let reached = false;
    gate.addUser = () => {
      reached = true;
      return opening.promise;
    };
    const order: string[] = [];
    const q = chatQueue();
    const real = q.settle.bind(q);
    vi.spyOn(q, "settle").mockImplementation(async (...a) => {
      order.push("settle");
      return real(...a);
    });
    const synced = sync(app, who);
    await until(() => reached);
    markShuttingDown();
    const closing = settleAfterReply().then(() => order.push("closeDb"));
    opening.release();
    await closing;
    expect(order).toEqual(["settle", "closeDb"]);
    expect(await getRedis().exists(keysOf(who.conversationId).active)).toBe(0);
    expect(await idsIn(keysOf(who.conversationId).taken)).toEqual([id]);
    expect(((await (await synced).json()) as { data: { running: boolean } }).data.running).toBe(true);
  });
});

describe("a shutdown during a card's opening", () => {
  const POINTS = ["before the resume", "between the resume and the answer", "after the answer"] as const;
  for (const card of CARDS) {
    for (const point of POINTS) {
      it(`leaves a failed ending for a ${card.kind} answer when it lands ${point} (SD-08)`, async () => {
        const id = `sd8-${card.kind.length}-${POINTS.indexOf(point)}`;
        const who = await stoppedAt(card, id);
        let pendingAtFlag = false;
        const flag = (): void => {
          markShuttingDown();
          pendingAtFlag = pendingAfterReply().some((p) => p.conversationId === who.conversationId);
        };
        if (point === "before the resume") {
          const q = chatQueue();
          const real = q.resume.bind(q);
          vi.spyOn(q, "resume").mockImplementation(async (...a) => {
            flag();
            return real(...a);
          });
        } else {
          gate.take = (stage) => {
            if ((stage === "before") === (point === "between the resume and the answer")) flag();
          };
        }
        const res = await answerCard(who, card, id);
        expect(((await res.json()) as { data: { running: boolean } }).data.running).toBe(false);
        expect(pendingAtFlag).toBe(true);
        await untilIdle(who.conversationId);
        const reply = (await rowsOf(who.conversationId)).filter((r) => r.role === "assistant").at(-1);
        expect(reply?.parts).toContainEqual({ type: "failed", reason: "shutdown" });
        expect(await cardStatus(who.conversationId, id)).toBe("success");
      });
    }
  }

  it("tells a page that attached that the turn failed for the shutdown (SD-09)", async () => {
    const card = CARDS[0];
    const who = await stoppedAt(card, "sd9");
    const watch = attachThenShutDown(who.conversationId);
    runObservers.push(watch.observe);
    try {
      const res = await answerCard(who, card, "sd9");
      expect(((await res.json()) as { data: { running: boolean } }).data.running).toBe(true);
      const frames = turnFrames(await watch.frames());
      expect(frames.map((f) => f.type)).toEqual(["data-failed", "error"]);
      expect(frames[0]).toEqual({ type: "data-failed", data: { reason: "shutdown" } });
    } finally {
      runObservers.splice(runObservers.indexOf(watch.observe), 1);
    }
    await untilIdle(who.conversationId);
    const reply = (await rowsOf(who.conversationId)).filter((r) => r.role === "assistant").at(-1);
    expect(reply?.parts).toContainEqual({ type: "failed", reason: "shutdown" });
  });

  it("leaves what waits for a new process's sync to answer (SD-11)", async () => {
    const who = await seedOwner(sql, app);
    const m2 = crypto.randomUUID();
    await getRedis().rpush(keysOf(who.conversationId).queue, itemOf(who, m2));
    markShuttingDown();
    expect(((await (await sync(app, who)).json()) as { data: { running: boolean } }).data.running).toBe(false);
    resetShutdownFlagForTests();
    const { createApp } = await import("@server/app.js");
    const fresh = createApp();
    expect(((await (await sync(fresh, who)).json()) as { data: { running: boolean } }).data.running).toBe(true);
    await untilIdle(who.conversationId);
    expect((await rowsOf(who.conversationId)).filter((r) => r.id === m2)).toHaveLength(1);
    expect((await rowsOf(who.conversationId)).filter((r) => r.role === "assistant")).toHaveLength(1);
  });
});
