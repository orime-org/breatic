// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the chat routes of inner#1717 answer, and what they leave in Redis,
 * on a real Redis and database.
 *
 * Every route that touches a conversation's run checks the caller as
 * `POST /chat/message` does and, when it refuses, changes nothing: no key
 * written, no run opened, no stop published. `/stream` attaches to whatever
 * run holds the conversation now and answers 204 when there is none to
 * attach to. A run holds its place in the running list for as long as it
 * runs and gives it up as it ends.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, inject, vi } from "vitest";

/** Per model call, by its index: a hold, and what it says. */
const script = vi.hoisted(() => ({
  at: [] as Array<{ hold?: Promise<void>; parts?: () => unknown[] } | undefined>,
  count: 0,
}));

/** Hooks into the reply's persist; pass-through by default. */
const gate = vi.hoisted(() => ({ persist: undefined as undefined | (() => Promise<void> | void) }));

/** The error log, watched; every other level goes to the real logger. */
const logged = vi.hoisted(() => ({ error: [] as unknown[][] }));

/** A lease short enough to watch it renew, with room for a loaded test process. */
const LEASE = vi.hoisted(() => ({ ms: 1200, renewMs: 300 }));

/** What the run held and gave back of its place in the running list, in order. */
const leases = vi.hoisted(() => ({ events: [] as string[] }));

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
  return {
    ...actual,
    logger,
    getAgentConfig: () => ({ ...actual.getAgentConfig(), chat_run_lease_ms: LEASE.ms, chat_run_renew_ms: LEASE.renewMs }),
  };
});

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
          const step = script.at[script.count++];
          if (step?.hold !== undefined) {
            await Promise.race([
              step.hold,
              new Promise<void>((resolve) => asked.abortSignal?.addEventListener("abort", () => resolve())),
            ]);
          }
          const parts = step?.parts?.() ?? saying("hi");
          return {
            stream: new ReadableStream({
              async start(controller) {
                for (const p of parts) {
                  // A pause in the script: a stretch of thinking takes time.
                  if ((p as { type: string }).type === "pause") await new Promise((r) => setTimeout(r, 30));
                  else if (asked.abortSignal?.aborted !== true) controller.enqueue(p as never);
                }
                controller.close();
              },
            }),
          };
        },
      })),
  };
});

vi.mock("@server/modules/conversation/conversation-message.repo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof MessageRepoModule>();
  return {
    ...actual,
    addMessage: async (...args: Parameters<typeof actual.addMessage>) => {
      if (args[1].role === "assistant") await gate.persist?.();
      return actual.addMessage(...args);
    },
  };
});

vi.mock("@server/modules/conversation/running-turns.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RunningTurnsModule>();
  return {
    ...actual,
    holdRunning: async (...args: Parameters<typeof actual.holdRunning>) => {
      const lease = await actual.holdRunning(...args);
      leases.events.push(`hold ${args[0].runId}`);
      return {
        ...lease,
        release: async () => {
          await lease.release();
          leases.events.push(`release ${args[0].runId}`);
        },
      };
    },
  };
});

import type * as CoreModule from "@breatic/core";
import type * as RunningTurnsModule from "@server/modules/conversation/running-turns.service.js";
import type * as DomainModule from "@breatic/domain";
import type * as MessageRepoModule from "@server/modules/conversation/conversation-message.repo.js";
import crypto from "node:crypto";
import postgres from "postgres";
import { env, getAgentConfig, getRedis, initCore, loadLocales, sessionCookieName, setSession } from "@breatic/core";
import { t } from "@breatic/shared";
import type { Hono } from "hono";
import { finishing, FINISHED_ASKING_FOR_A_TOOL } from "../helpers/model-double.js";
import { runStreams } from "@server/agent/run-stream.js";
import { attach, keysOf, seedOwner, send, sendAndRead, stop, sync, takeBack, until, untilIdle, type Seeded } from "./chat-run-harness.js";

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
  vi.restoreAllMocks();
  script.at = [];
  script.count = 0;
  gate.persist = undefined;
  logged.error = [];
  leases.events = [];
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
 * @returns The item as Redis holds it.
 */
function itemOf(who: Seeded, id: string): string {
  return JSON.stringify({ id, sentAt: new Date().toISOString(), userId: who.userId, acceptLanguage: "en", message: `m ${id.slice(0, 4)}`, attached_chips: [] });
}

/**
 * The ids in one of a conversation's lists.
 * @param key - The list.
 * @returns The ids, in order.
 */
async function idsIn(key: string): Promise<string[]> {
  return (await getRedis().lrange(key, 0, -1)).map((raw) => (JSON.parse(raw) as { id: string }).id);
}

/**
 * Everything a conversation's five keys hold, for comparing before and after.
 * @param c - The conversation.
 * @returns Each key's content.
 */
async function snapshotOf(c: string): Promise<Record<string, unknown>> {
  const r = getRedis();
  const k = keysOf(c);
  return {
    active: await r.get(k.active),
    queue: await r.lrange(k.queue, 0, -1),
    taken: await r.lrange(k.taken, 0, -1),
    ids: (await r.smembers(k.ids)).sort(),
    awaiting: await r.get(k.awaiting),
  };
}

/**
 * Listen for stops published to any run, on a connection of its own.
 * @returns The channels heard, and how to stop listening.
 */
async function listenForStops(): Promise<{ heard: string[]; close: () => Promise<void> }> {
  const sub = getRedis().duplicate();
  const heard: string[] = [];
  sub.on("pmessage", (_pattern: string, channel: string) => heard.push(channel));
  await sub.psubscribe(`${env.REDIS_KEY_PREFIX}:chat:stop:*`);
  return {
    heard,
    close: async () => {
      await sub.quit();
    },
  };
}

/**
 * A user signed in, with no membership yet.
 * @returns Their id and cookie.
 */
async function signedIn(): Promise<{ userId: string; cookie: string }> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`other-${crypto.randomBytes(4).toString("hex")}@example.com`}, true) RETURNING id
  `;
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, user!.id);
  return { userId: user!.id, cookie: `${sessionCookieName()}=${token}` };
}

/**
 * Make a user a member of a project.
 * @param projectId - The project.
 * @param userId - The user.
 * @param role - Their role.
 * @param addedBy - Who added them.
 */
async function join(projectId: string, userId: string, role: "editor" | "viewer", addedBy: string): Promise<void> {
  const [project] = await sql<{ studio_id: string }[]>`SELECT studio_id FROM projects WHERE id = ${projectId}`;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${project!.studio_id}, ${userId}, 'guest') ON CONFLICT DO NOTHING`;
  await sql`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${projectId}, ${userId}, ${role}, ${addedBy})`;
}

/**
 * A conversation of a user in a project, written directly.
 * @param userId - Its owner.
 * @param projectId - Its project.
 * @returns Its id.
 */
async function conversationOf(userId: string, projectId: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`INSERT INTO conversations (user_id, title, project_id) VALUES (${userId}, 'c', ${projectId}) RETURNING id`;
  return row!.id;
}

/** The four routes that act on a conversation's run, each as the page calls it. */
const ROUTES: Array<{ name: string; call: (who: Seeded, messageId: string) => Promise<Response> }> = [
  { name: "POST /chat/message", call: (who) => send(app, who, { message: "hello" }) },
  { name: "POST /chat/conversations/:id/sync", call: (who) => sync(app, who) },
  { name: "POST /chat/stop", call: (who) => stop(app, who) },
  { name: "DELETE /chat/conversations/:id/queue/:messageId", call: (who, messageId) => takeBack(app, who, messageId) },
];

describe("a caller the routes refuse", () => {
  const CASES: Array<{ name: string; status: number; caller: (owner: Seeded) => Promise<Seeded> }> = [
    {
      name: "is not a member of the project",
      status: 404,
      caller: async (owner) => ({ ...owner, ...(await signedIn()) }),
    },
    {
      name: "is a viewer in the project",
      status: 403,
      caller: async (owner) => {
        const other = await signedIn();
        await join(owner.projectId, other.userId, "viewer", owner.userId);
        return { ...other, projectId: owner.projectId, conversationId: await conversationOf(other.userId, owner.projectId) };
      },
    },
    {
      name: "names another user's conversation",
      status: 404,
      caller: async (owner) => {
        const other = await signedIn();
        await join(owner.projectId, other.userId, "editor", owner.userId);
        return { ...owner, ...other };
      },
    },
    {
      name: "names another of their projects for the conversation",
      status: 404,
      caller: async (owner) => {
        const elsewhere = await seedOwner(sql, app);
        await join(elsewhere.projectId, owner.userId, "editor", elsewhere.userId);
        return { ...owner, projectId: elsewhere.projectId };
      },
    },
    {
      name: "names a deleted conversation",
      status: 404,
      caller: async (owner) => {
        await sql`UPDATE conversations SET deleted_at = now() WHERE id = ${owner.conversationId}`;
        return owner;
      },
    },
  ];
  for (const route of ROUTES) {
    for (const refused of CASES) {
      it(`${route.name} answers ${String(refused.status)} when the caller ${refused.name}, and changes nothing (RT-09)`, async () => {
        const owner = await seedOwner(sql, app);
        const waiting = crypto.randomUUID();
        await getRedis().rpush(keysOf(owner.conversationId).queue, itemOf(owner, waiting));
        await getRedis().set(keysOf(owner.conversationId).active, "R-running");
        const caller = await refused.caller(owner);
        const before = await snapshotOf(owner.conversationId);
        const otherBefore = await snapshotOf(caller.conversationId);
        const stops = await listenForStops();
        try {
          const res = await route.call(caller, waiting);
          expect(res.status).toBe(refused.status);
          await new Promise((r) => setTimeout(r, 50));
          expect(await snapshotOf(owner.conversationId)).toEqual(before);
          expect(await snapshotOf(caller.conversationId)).toEqual(otherBefore);
          expect(stops.heard).toEqual([]);
          expect(script.count).toBe(0);
        } finally {
          await stops.close();
          await getRedis().del(...Object.values(keysOf(owner.conversationId)));
        }
      });
    }
  }
});

describe("GET /chat/conversations/:id/stream", () => {
  it("answers as GET /chat/conversations/:id does for another user's conversation, and 404 for a deleted one (RT-09b)", async () => {
    const owner = await seedOwner(sql, app);
    const other = await signedIn();
    await join(owner.projectId, other.userId, "editor", owner.userId);
    const read = await app.request(`/api/v1/chat/conversations/${owner.conversationId}`, { headers: { Cookie: other.cookie } });
    expect(read.status).toBe(403);
    expect((await attach(app, { ...owner, ...other })).status).toBe(read.status);
    await sql`UPDATE conversations SET deleted_at = now() WHERE id = ${owner.conversationId}`;
    expect((await attach(app, owner)).status).toBe(404);
  });

  it("attaches the owner to a running run even after they became a viewer (RT-09b)", async () => {
    const owner = await seedOwner(sql, app);
    const editor = await signedIn();
    await join(owner.projectId, editor.userId, "editor", owner.userId);
    const opened = await app.request("/api/v1/chat/open", {
      method: "POST",
      headers: { Cookie: editor.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: owner.projectId }),
    });
    const conversationId = ((await opened.json()) as { data: { current: { conversation: { id: string } } } }).data.current.conversation.id;
    const who: Seeded = { ...editor, projectId: owner.projectId, conversationId };
    const model = held();
    script.at = [{ hold: model.promise }];
    await send(app, who, { message: "first" });
    await until(() => script.count >= 1);
    await sql`UPDATE project_members SET role = 'viewer' WHERE project_id = ${owner.projectId} AND user_id = ${editor.userId}`;
    const reading = attach(app, who);
    await new Promise((r) => setTimeout(r, 50));
    model.release();
    expect((await reading).status).toBe(200);
    await untilIdle(conversationId);
  });

  it("answers 204 when no run holds the conversation, whatever an earlier run's stream left (RT-21)", async () => {
    const who = await seedOwner(sql, app);
    await getRedis().set(`${env.REDIS_KEY_PREFIX}:chat-stream:rs:sentinel:R-old`, "DONE");
    expect((await attach(app, who)).status).toBe(204);
  });

  it("answers 204 when the run holding it has no stream yet, or its stream is done (RT-21)", async () => {
    const who = await seedOwner(sql, app);
    await getRedis().set(keysOf(who.conversationId).active, "R-opening");
    expect((await attach(app, who)).status).toBe(204);
    await getRedis().set(keysOf(who.conversationId).active, "R-done");
    await getRedis().set(`${env.REDIS_KEY_PREFIX}:chat-stream:rs:sentinel:R-done`, "DONE");
    expect((await attach(app, who)).status).toBe(204);
    await getRedis().del(keysOf(who.conversationId).active);
  });

  it("answers 204 and logs when the run's producer is gone (ST-19)", async () => {
    const who = await seedOwner(sql, app);
    await getRedis().set(keysOf(who.conversationId).active, "R-dead");
    await getRedis().set(`${env.REDIS_KEY_PREFIX}:chat-stream:rs:sentinel:R-dead`, "1");
    const from = Date.now();
    expect((await attach(app, who)).status).toBe(204);
    expect(Date.now() - from).toBeLessThan(5000);
    expect(logged.error.some(([fields]) => (fields as { err?: unknown; conversationId?: string }).err !== undefined)).toBe(true);
    await getRedis().del(keysOf(who.conversationId).active);
  });

  it("answers 204 and logs when reading the stream fails (ST-21)", async () => {
    const who = await seedOwner(sql, app);
    await getRedis().set(keysOf(who.conversationId).active, "R-any");
    vi.spyOn(runStreams(), "resumeExistingStream").mockRejectedValueOnce(new Error("subscribe failed"));
    expect((await attach(app, who)).status).toBe(204);
    expect(logged.error.some(([fields]) => (fields as { err?: Error }).err?.message === "subscribe failed")).toBe(true);
    await getRedis().del(keysOf(who.conversationId).active);
  });

  it("attaches to the run that holds the conversation now, from its start (RT-21b)", async () => {
    const who = await seedOwner(sql, app);
    const first = held();
    const second = held();
    script.at = [{ hold: first.promise }, { hold: second.promise }];
    await send(app, who, { message: "first" });
    await until(() => script.count >= 1);
    await send(app, who, { message: "second" });
    const r1 = await getRedis().get(keysOf(who.conversationId).active);
    await stop(app, who);
    await until(async () => {
      const now = await getRedis().get(keysOf(who.conversationId).active);
      return now !== null && now !== r1 && (await getRedis().exists(`${env.REDIS_KEY_PREFIX}:chat-stream:rs:sentinel:${now}`)) === 1;
    });
    const reading = attach(app, who);
    await new Promise((r) => setTimeout(r, 50));
    second.release();
    first.release();
    const { frames } = await reading;
    expect(frames[0]?.type).toBe("data-heartbeat");
    expect(frames.some((f) => f.type === "data-interrupted")).toBe(false);
    expect(frames.some((f) => f.type === "text-delta")).toBe(true);
    await untilIdle(who.conversationId);
  });
});

describe("POST /chat/stop", () => {
  it("publishes to the run that holds the conversation, and names its keys, under the deployment's prefix (RT-23, ST-23)", async () => {
    const who = await seedOwner(sql, app);
    await getRedis().set(keysOf(who.conversationId).active, "R1");
    const stops = await listenForStops();
    try {
      expect(await (await stop(app, who)).json()).toEqual({ data: { stopped: true } });
      await until(() => stops.heard.length > 0);
      expect(stops.heard).toEqual([`${env.REDIS_KEY_PREFIX}:chat:stop:R1`]);
      const c = who.conversationId;
      const at = `${env.REDIS_KEY_PREFIX}:server`;
      expect(keysOf(c)).toEqual({
        active: `${at}:chat-active:${c}`,
        queue: `${at}:chat-queue:${c}`,
        taken: `${at}:chat-taken:${c}`,
        ids: `${at}:chat-queue-ids:${c}`,
        awaiting: `${at}:chat-awaiting:${c}`,
      });
    } finally {
      await stops.close();
      await getRedis().del(keysOf(who.conversationId).active);
    }
  });

  it("publishes nothing when no run holds the conversation (RT-23)", async () => {
    const who = await seedOwner(sql, app);
    const stops = await listenForStops();
    try {
      expect(await (await stop(app, who)).json()).toEqual({ data: { stopped: false } });
      await new Promise((r) => setTimeout(r, 100));
      expect(stops.heard).toEqual([]);
    } finally {
      await stops.close();
    }
  });
});

describe("POST /chat/message", () => {
  it("refuses a message past the queue's cap with queue_full in the user's words (RT-05)", async () => {
    const who = await seedOwner(sql, app);
    const k = keysOf(who.conversationId);
    await getRedis().set(k.active, "R-running");
    for (let i = 0; i < getAgentConfig().chat_queue_max; i++) await getRedis().rpush(k.queue, itemOf(who, crypto.randomUUID()));
    const res = await send(app, who, { message: "one too many" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: unknown }).error).toEqual({ code: 409, message: t("server.chat.queue_full"), reason: "queue_full" });
    await getRedis().del(...Object.values(k));
  });

  it("refuses an answer that does not fit its card with 422 (RT-17)", async () => {
    const who = await seedOwner(sql, app);
    script.at = [{
      parts: () => [
        {
          type: "tool-call",
          toolCallId: "rt17",
          toolName: "ask_user",
          input: JSON.stringify({ questions: [{ header: "Ratio", question: "Which ratio?", options: [{ label: "16:9" }, { label: "9:16" }] }] }),
        },
        FINISHED_ASKING_FOR_A_TOOL,
      ],
    }];
    await send(app, who, { message: "ask me" });
    await untilIdle(who.conversationId);
    const res = await app.request("/api/v1/chat/message", {
      method: "POST",
      headers: { Cookie: who.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "",
        project_id: who.projectId,
        conversation_id: who.conversationId,
        answer: { toolCallId: "rt17", answers: [{ index: 5, selected: ["nope"] }] },
      }),
    });
    expect(res.status).toBe(422);
    expect(await getRedis().get(keysOf(who.conversationId).awaiting)).toBe("rt17");
  });
});

describe("a run's end", () => {
  it("frees the conversation without a next run when its reply could not be stored (ST-05)", async () => {
    const who = await seedOwner(sql, app);
    const model = held();
    script.at = [{ hold: model.promise }];
    gate.persist = () => {
      throw new Error("database write failed");
    };
    await send(app, who, { message: "first" });
    await until(() => script.count >= 1);
    const m2 = crypto.randomUUID();
    await send(app, who, { id: m2, message: "second" });
    const reading = attach(app, who);
    await new Promise((r) => setTimeout(r, 50));
    await stop(app, who);
    // Let go only once the stop has ended the run: a step the model finished
    // first would take the second message in before the stop lands.
    const { frames } = await reading;
    model.release();
    expect(frames.some((f) => f.type === "data-next-run")).toBe(false);
    await untilIdle(who.conversationId);
    expect(await idsIn(keysOf(who.conversationId).queue)).toEqual([m2]);
  });

  it("ends a turn stopped at a card after the output ran out with truncation, thinking time and then the card (ST-12)", async () => {
    const who = await seedOwner(sql, app);
    script.at = [{
      parts: () => [
        { type: "reasoning-start", id: "r" },
        { type: "reasoning-delta", id: "r", delta: "hmm" },
        { type: "pause" },
        { type: "reasoning-end", id: "r" },
        {
          type: "tool-call",
          toolCallId: "st12",
          toolName: "ask_user",
          input: JSON.stringify({ questions: [{ header: "Ratio", question: "Which ratio?", options: [{ label: "16:9" }, { label: "9:16" }] }] }),
        },
        finishing("length", 1),
      ],
    }];
    const { chunks: frames } = await sendAndRead(app, who.cookie, { message: "ask me", project_id: who.projectId, conversation_id: who.conversationId });
    const marks = frames.map((f) => String(f.type)).filter((type) => ["data-thinking-time", "data-truncated", "data-ask-awaiting", "data-next-run"].includes(type));
    // The card last, where the browser splits the reply once it is answered.
    expect(marks).toEqual(["data-truncated", "data-thinking-time", "data-ask-awaiting"]);
    await untilIdle(who.conversationId);
  });
});

describe("a run's place in the running list", () => {
  /**
   * The running list's members and scores for an owner in a project.
   * @param who - Whose.
   * @returns Each member with its score.
   */
  async function running(who: Seeded): Promise<Array<{ member: string; score: number }>> {
    const flat = await getRedis().zrange(`${env.REDIS_KEY_PREFIX}:server:chat-running:${who.userId}:${who.projectId}`, 0, -1, "WITHSCORES");
    const out: Array<{ member: string; score: number }> = [];
    for (let i = 0; i < flat.length; i += 2) out.push({ member: flat[i]!, score: Number(flat[i + 1]) });
    return out;
  }

  it("is renewed with the run's hold on the conversation while the run lasts (LS-02)", async () => {
    const who = await seedOwner(sql, app);
    const model = held();
    script.at = [{ hold: model.promise }];
    await send(app, who, { message: "long" });
    await until(() => script.count >= 1);
    const k = keysOf(who.conversationId);
    const scores: number[] = [];
    const ttls: number[] = [];
    const end = Date.now() + 1500;
    while (Date.now() < end) {
      expect(await getRedis().exists(k.active)).toBe(1);
      ttls.push(await getRedis().pttl(k.active));
      scores.push((await running(who))[0]!.score);
      await new Promise((r) => setTimeout(r, 50));
    }
    model.release();
    await untilIdle(who.conversationId);
    expect(new Set(scores).size).toBeGreaterThanOrEqual(4);
    expect(Math.max(...ttls)).toBeGreaterThan(LEASE.ms - 150);
    expect(Math.min(...ttls)).toBeGreaterThan(0);
  });

  it("is held for the next run before the run that ended gives up its own (LS-04)", async () => {
    const who = await seedOwner(sql, app);
    const model = held();
    script.at = [{ hold: model.promise }];
    await send(app, who, { message: "first" });
    await until(() => script.count >= 1);
    await send(app, who, { message: "second" });
    const r = getRedis();
    const r1 = (await r.get(keysOf(who.conversationId).active))!;
    let gap = false;
    let watching = true;
    const watch = (async () => {
      while (watching) {
        const res = await app.request(`/api/v1/chat/running?project_id=${who.projectId}`, { headers: { Cookie: who.cookie } });
        const ids = ((await res.json()) as { data: { conversation_ids: string[] } }).data.conversation_ids;
        if (!ids.includes(who.conversationId) && (await r.exists(keysOf(who.conversationId).active)) === 1) gap = true;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })();
    await stop(app, who);
    // Let go only once the next run holds it: a step the model finished
    // first would take the second message into this run instead.
    await until(async () => {
      const now = await r.get(keysOf(who.conversationId).active);
      return now !== null && now !== r1;
    });
    model.release();
    const r2 = (await r.get(keysOf(who.conversationId).active))!;
    await untilIdle(who.conversationId);
    watching = false;
    await watch;
    const held2 = leases.events.indexOf(`hold ${r2}`);
    const released1 = leases.events.indexOf(`release ${r1}`);
    expect(held2).toBeGreaterThanOrEqual(0);
    expect(released1).toBeGreaterThan(held2);
    expect(gap).toBe(false);
  });

  it("is given up when the run stops at a card (LS-07)", async () => {
    const who = await seedOwner(sql, app);
    script.at = [{
      parts: () => [
        {
          type: "tool-call",
          toolCallId: "ls7",
          toolName: "ask_user",
          input: JSON.stringify({ questions: [{ header: "Ratio", question: "Which ratio?", options: [{ label: "16:9" }, { label: "9:16" }] }] }),
        },
        FINISHED_ASKING_FOR_A_TOOL,
      ],
    }];
    await send(app, who, { message: "ask me" });
    await untilIdle(who.conversationId);
    await until(async () => (await running(who)).length === 0);
  });

  it("answers in the shape it always had while a run goes (RT-27)", async () => {
    const who = await seedOwner(sql, app);
    const model = held();
    script.at = [{ hold: model.promise }];
    await send(app, who, { message: "first" });
    await until(() => script.count >= 1);
    const res = await app.request(`/api/v1/chat/running?project_id=${who.projectId}`, { headers: { Cookie: who.cookie } });
    expect(await res.json()).toEqual({ data: { conversation_ids: [who.conversationId] } });
    model.release();
    await untilIdle(who.conversationId);
  });
});
