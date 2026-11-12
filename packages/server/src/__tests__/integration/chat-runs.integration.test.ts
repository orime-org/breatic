// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A conversation's runs through the routes, on a real Redis and database
 * (inner#1717).
 *
 * A send answers with its status once the run it opened has its opening row
 * and its stream; a sync opens a run for what waits; a page attaches to the
 * stream of whichever run holds the conversation; stop is published to that
 * run; a message still waiting can be taken back. The model is a double whose
 * calls a case scripts, and a run that crashed is made the way a crash looks
 * from outside: its keys left behind, its `active` gone.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, inject, vi } from "vitest";

const faults = vi.hoisted(() => ({ historyFails: false, leaseFails: false }));

vi.mock("@server/agent/turn-context.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    buildTurnContext: async (...args: unknown[]) => {
      if (faults.historyFails) throw new Error("history read failed");
      return (actual.buildTurnContext as (...a: unknown[]) => Promise<unknown>)(...args);
    },
  };
});

vi.mock("@server/modules/conversation/running-turns.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    holdRunning: async (...args: unknown[]) => {
      if (faults.leaseFails) throw new Error("redis refused the lease");
      return (actual.holdRunning as (...a: unknown[]) => Promise<unknown>)(...args);
    },
  };
});

const script = vi.hoisted(() => ({
  calls: [] as Array<() => unknown[]>,
  prompts: [] as unknown[][],
  onCall: [] as Array<(() => void | Promise<void>) | undefined>,
  hold: undefined as Promise<void> | undefined,
  count: 0,
}));

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  const { MockLanguageModelV4 } = await import("ai/test");
  const { FINISHED } = await import("../helpers/model-double.js");
  return {
    ...actual,
    resolveProvider: () => "test",
    getModel: () =>
      new MockLanguageModelV4({
        doStream: async (asked) => {
          const i = script.count++;
          script.prompts.push(asked.prompt);
          await script.onCall[i]?.();
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
                controller.close();
              },
            }),
          };
        },
      }),
  };
});

import type * as DomainModule from "@breatic/domain";
import crypto from "node:crypto";
import postgres from "postgres";
import { getRedis, initCore, loadLocales, env } from "@breatic/core";
import type { Hono } from "hono";
import { attach, keysOf, listIds, seedOwner, send, stop, sync, takeBack, until, untilIdle, type Seeded } from "./chat-run-harness.js";

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
  faults.historyFails = false;
  faults.leaseFails = false;
  script.calls = [];
  script.prompts = [];
  script.onCall = [];
  script.hold = undefined;
  script.count = 0;
});

/**
 * The stored rows of a conversation.
 * @param c - The conversation.
 * @returns Each row's id, role, turn and parts, in order.
 */
async function rowsOf(c: string): Promise<Array<{ id: string; role: string; turn_index: number; parts: Array<Record<string, unknown>> }>> {
  return sql`
    SELECT id, role, turn_index, parts FROM conversation_messages
    WHERE conversation_id = ${c} AND deleted_at IS NULL ORDER BY turn_index, seq
  `;
}

/**
 * A queue item as a send would have queued it.
 * @param who - Whose conversation.
 * @param id - The message id.
 * @param words - What was typed.
 * @returns Its JSON.
 */
function queued(who: Seeded, id: string, words: string): string {
  return JSON.stringify({
    id,
    sentAt: new Date().toISOString(),
    userId: who.userId,
    acceptLanguage: "en",
    message: words,
    attached_chips: [],
    project_id: who.projectId,
    conversation_id: who.conversationId,
  });
}

describe("POST /chat/message", () => {
  it("refuses a new message without an id as malformed (RT-01)", async () => {
    const who = await seedOwner(sql, app);
    const res = await app.request("/api/v1/chat/message", {
      method: "POST",
      headers: { Cookie: who.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi", project_id: who.projectId, conversation_id: who.conversationId }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { reason?: string } }).error.reason).toBe("request_shape");
    expect(await getRedis().exists(keysOf(who.conversationId).queue)).toBe(0);
  });

  it("answers start once the opening row and the stream exist (RT-02, SR-01)", async () => {
    const who = await seedOwner(sql, app);
    const id = crypto.randomUUID();
    const res = await send(app, who, { id, message: "first" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { status: "start", pending: [], running: true } });
    const rows = await rowsOf(who.conversationId);
    expect(rows.find((r) => r.id === id)?.role).toBe("user");
    const active = await getRedis().get(keysOf(who.conversationId).active);
    if (active !== null) {
      expect(await getRedis().get(`${env.REDIS_KEY_PREFIX}:chat-stream:rs:sentinel:${active}`)).not.toBeNull();
    }
    await untilIdle(who.conversationId);
  });

  it("queues behind a running run and answers the queue as the page shows it (RT-03)", async () => {
    const who = await seedOwner(sql, app);
    let release!: () => void;
    script.hold = new Promise((r) => {
      release = r;
    });
    await send(app, who, { message: "first" });
    // The run's first step has taken what waited before its model call.
    await until(() => script.count >= 1);
    const id = crypto.randomUUID();
    const chip = { id: "c1", type: "image", name: "a.png", data_snapshot: { url: "https://cdn.example/a.png" } };
    const res = await send(app, who, { id, message: "改成蓝色", attached_chips: [chip] });
    const body = (await res.json()) as { data: { status: string; pending: Array<Record<string, unknown>>; running: boolean } };
    expect(body.data.status).toBe("queued");
    expect(body.data.running).toBe(true);
    expect(body.data.pending).toEqual([{ id, sentAt: expect.any(String), words: "改成蓝色", chips: [chip] }]);
    expect(Object.keys(body.data.pending[0]!).sort()).toEqual(["chips", "id", "sentAt", "words"]);
    release();
    await untilIdle(who.conversationId);
  });

  it("answers duplicate for the same id sent again (RT-04)", async () => {
    const who = await seedOwner(sql, app);
    let release!: () => void;
    script.hold = new Promise((r) => {
      release = r;
    });
    await send(app, who, { message: "first" });
    await until(() => script.count >= 1);
    const id = crypto.randomUUID();
    await send(app, who, { id, message: "again" });
    const res = await send(app, who, { id, message: "again" });
    const body = (await res.json()) as { data: { status: string; pending: Array<{ id: string }> } };
    expect(body.data.status).toBe("duplicate");
    expect(body.data.pending.filter((p) => p.id === id)).toHaveLength(1);
    release();
    await untilIdle(who.conversationId);
  });

  it("records who sent a queued message, in which language and from where (RT-08)", async () => {
    const who = await seedOwner(sql, app);
    let release!: () => void;
    script.hold = new Promise((r) => {
      release = r;
    });
    await send(app, who, { message: "first" });
    await until(() => script.count >= 1);
    const id = crypto.randomUUID();
    await send(app, who, { id, message: "queued one", time_zone: "Asia/Seoul" }, { "Accept-Language": "ko" });
    const [raw] = await getRedis().lrange(keysOf(who.conversationId).queue, 0, -1);
    expect(JSON.parse(raw!)).toMatchObject({ id, sentAt: expect.any(String), userId: who.userId, acceptLanguage: "ko", message: "queued one", time_zone: "Asia/Seoul" });
    release();
    await untilIdle(who.conversationId);
  });
});

describe("a run reads what is sent while it runs", () => {
  it("answers a message queued during the run in the same reply, once (verifies drain end to end)", async () => {
    const who = await seedOwner(sql, app);
    const later = crypto.randomUUID();
    script.calls = [
      () => [
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "first answer" },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
      ],
    ];
    script.onCall[0] = async () => {
      await send(app, who, { id: later, message: "and blue" });
    };
    await send(app, who, { message: "make a poster" });
    await untilIdle(who.conversationId);
    const replies = (await rowsOf(who.conversationId)).filter((r) => r.role === "assistant");
    expect(replies).toHaveLength(1);
    expect(replies[0]!.parts.filter((p) => p.type === "user-message").map((p) => p.id)).toEqual([later]);
  });
});

describe("POST /chat/conversations/:id/sync", () => {
  it("opens a run for what waits and answers once its opening is done (RT-10)", async () => {
    const who = await seedOwner(sql, app);
    const id = crypto.randomUUID();
    await getRedis().rpush(keysOf(who.conversationId).queue, queued(who, id, "left waiting"));
    const res = await sync(app, who);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toEqual({ pending: [], running: true, awaiting: false, next_sync_ms: expect.any(Number) });
    expect((await rowsOf(who.conversationId)).find((r) => r.id === id)?.role).toBe("user");
    await untilIdle(who.conversationId);
  });

  it("does not open a run while a card waits (RT-11)", async () => {
    const who = await seedOwner(sql, app);
    const id = crypto.randomUUID();
    await getRedis().set(keysOf(who.conversationId).awaiting, "T1");
    await getRedis().rpush(keysOf(who.conversationId).queue, queued(who, id, "waiting"));
    const body = (await (await sync(app, who)).json()) as { data: { running: boolean; awaiting: boolean; pending: Array<{ id: string }> } };
    expect(body.data.running).toBe(false);
    expect(body.data.awaiting).toBe(true);
    expect(body.data.pending.map((p) => p.id)).toEqual([id]);
    expect(await getRedis().exists(keysOf(who.conversationId).active)).toBe(0);
  });

  it("answers its opening message once more after a crash, reusing the row (SR-07)", async () => {
    const who = await seedOwner(sql, app);
    const m1 = crypto.randomUUID();
    await send(app, who, { id: m1, message: "crash me" });
    await untilIdle(who.conversationId);
    await sql`DELETE FROM conversation_messages WHERE conversation_id = ${who.conversationId} AND role = 'assistant'`;
    await getRedis().rpush(keysOf(who.conversationId).taken, queued(who, m1, "crash me"));
    await sync(app, who);
    await untilIdle(who.conversationId);
    const rows = await rowsOf(who.conversationId);
    expect(rows.filter((r) => r.id === m1)).toHaveLength(1);
    const userRow = rows.find((r) => r.id === m1)!;
    expect(rows.filter((r) => r.role === "assistant" && r.turn_index === userRow.turn_index)).toHaveLength(1);
    expect(await getRedis().exists(keysOf(who.conversationId).taken)).toBe(0);
  });

  it("drops what a stored reply already answered and calls no model when nothing is left (SR-08)", async () => {
    const who = await seedOwner(sql, app);
    await send(app, who, { message: "open" });
    await untilIdle(who.conversationId);
    const m3 = crypto.randomUUID();
    const [reply] = (await rowsOf(who.conversationId)).filter((r) => r.role === "assistant");
    await sql`UPDATE conversation_messages SET parts = parts || ${sql.json([{ type: "user-message", id: m3, sentAt: new Date().toISOString(), parts: [{ type: "text", text: "x" }] }])}::jsonb WHERE id = ${reply!.id}`;
    await getRedis().rpush(keysOf(who.conversationId).taken, queued(who, m3, "x"));
    const before = script.count;
    const body = (await (await sync(app, who)).json()) as { data: { running: boolean } };
    expect(body.data.running).toBe(false);
    await untilIdle(who.conversationId);
    expect(script.count).toBe(before);
    expect(await getRedis().exists(keysOf(who.conversationId).taken)).toBe(0);
    expect((await rowsOf(who.conversationId)).filter((r) => r.id === m3)).toHaveLength(0);
  });

  it("goes on to the queue when everything taken was answered (SR-09)", async () => {
    const who = await seedOwner(sql, app);
    const m1 = crypto.randomUUID();
    await send(app, who, { id: m1, message: "answered already" });
    await untilIdle(who.conversationId);
    const m4 = crypto.randomUUID();
    await getRedis().rpush(keysOf(who.conversationId).taken, queued(who, m1, "answered already"));
    await getRedis().rpush(keysOf(who.conversationId).queue, queued(who, m4, "next one"));
    const body = (await (await sync(app, who)).json()) as { data: { running: boolean; pending: unknown[] } };
    expect(body.data.running).toBe(true);
    expect(body.data.pending).toEqual([]);
    await untilIdle(who.conversationId);
    const rows = await rowsOf(who.conversationId);
    const m4Row = rows.find((r) => r.id === m4);
    expect(m4Row?.role).toBe("user");
    expect(rows.filter((r) => r.role === "assistant" && r.turn_index === m4Row!.turn_index)).toHaveLength(1);
    const m1Row = rows.find((r) => r.id === m1)!;
    expect(rows.filter((r) => r.role === "assistant" && r.turn_index === m1Row.turn_index)).toHaveLength(1);
  });
});

describe("GET /chat/conversations/:id/stream", () => {
  it("answers 204 when no run holds the conversation (RT-21a)", async () => {
    const who = await seedOwner(sql, app);
    expect((await attach(app, who)).status).toBe(204);
  });

  it("replays the running run from its first frame (RT-22, ST-03)", async () => {
    const who = await seedOwner(sql, app);
    let release!: () => void;
    script.hold = new Promise((r) => {
      release = r;
    });
    await send(app, who, { message: "first" });
    const reading = attach(app, who);
    await new Promise((r) => setTimeout(r, 100));
    release();
    const { status, frames } = await reading;
    expect(status).toBe(200);
    expect(frames[0]).toEqual({ type: "data-heartbeat", transient: true, data: {} });
    expect(frames.some((f) => f.type === "text-delta")).toBe(true);
    expect(frames.at(-1)?.type).toBe("finish");
  });
});

describe("POST /chat/stop", () => {
  it("stops the running run and every page sees it stopped (RT-23a, ST-11)", async () => {
    const who = await seedOwner(sql, app);
    let release!: () => void;
    script.hold = new Promise((r) => {
      release = r;
    });
    await send(app, who, { message: "first" });
    const reading = attach(app, who);
    await new Promise((r) => setTimeout(r, 100));
    const res = await stop(app, who);
    expect(await res.json()).toEqual({ data: { stopped: true } });
    release();
    const { frames } = await reading;
    expect(frames.filter((f) => f.type === "data-interrupted")).toHaveLength(1);
    await untilIdle(who.conversationId);
    const reply = (await rowsOf(who.conversationId)).find((r) => r.role === "assistant");
    expect(reply?.parts.some((p) => p.type === "interrupted")).toBe(true);
  });

  it("answers stopped false when nothing runs (RT-23b)", async () => {
    const who = await seedOwner(sql, app);
    expect(await (await stop(app, who)).json()).toEqual({ data: { stopped: false } });
  });
});

describe("DELETE /chat/conversations/:id/queue/:messageId", () => {
  it("takes a waiting message back, and says when it was taken or is gone (RT-24)", async () => {
    const who = await seedOwner(sql, app);
    const k = keysOf(who.conversationId);
    const waiting = crypto.randomUUID();
    const taken = crypto.randomUUID();
    await getRedis().rpush(k.queue, queued(who, waiting, "w"));
    await getRedis().rpush(k.taken, queued(who, taken, "t"));
    await getRedis().set(k.active, "R-busy");
    expect(await (await takeBack(app, who, waiting)).json()).toEqual({ data: { status: "removed" } });
    expect(await (await takeBack(app, who, taken)).json()).toEqual({ data: { status: "taken" } });
    expect(await (await takeBack(app, who, crypto.randomUUID())).json()).toEqual({ data: { status: "gone" } });
    expect(await listIds(k.queue)).toEqual([]);
    await getRedis().del(k.active, k.taken);
  });
});

describe("the running list (#1394)", () => {
  it("lists the conversation while its run runs and not after (LS-01, LS-03)", async () => {
    const who = await seedOwner(sql, app);
    let release!: () => void;
    script.hold = new Promise((r) => {
      release = r;
    });
    await send(app, who, { message: "first" });
    const listed = async (): Promise<string[]> => {
      const res = await app.request(`/api/v1/chat/running?project_id=${who.projectId}`, { headers: { Cookie: who.cookie } });
      return ((await res.json()) as { data: { conversation_ids: string[] } }).data.conversation_ids;
    };
    await until(async () => (await listed()).includes(who.conversationId));
    release();
    await untilIdle(who.conversationId);
    await until(async () => !(await listed()).includes(who.conversationId));
  });
});

describe("a run on its own", () => {
  it("runs to its end when the page reading it goes away (SR-12, LS-08)", async () => {
    const who = await seedOwner(sql, app);
    let release!: () => void;
    script.hold = new Promise((r) => {
      release = r;
    });
    await send(app, who, { message: "first" });
    const abort = new AbortController();
    const res = await app.request(`/api/v1/chat/conversations/${who.conversationId}/stream`, {
      headers: { Cookie: who.cookie },
      signal: abort.signal,
    });
    expect(res.status).toBe(200);
    abort.abort();
    await res.body?.cancel().catch(() => {});
    release();
    await untilIdle(who.conversationId);
    const reply = (await rowsOf(who.conversationId)).find((r) => r.role === "assistant");
    expect(reply?.parts.some((p) => p.type === "interrupted")).toBe(false);
    expect(reply?.parts.some((p) => p.type === "text")).toBe(true);
  });

  it("tells the model the user's time in the zone the page sent (time zone into the turn)", async () => {
    const who = await seedOwner(sql, app);
    await send(app, who, { message: "what time is it", time_zone: "Asia/Tokyo" });
    await untilIdle(who.conversationId);
    expect(JSON.stringify(script.prompts[0])).toContain("Asia/Tokyo");
  });

  it("says it failed on the stream when it fails before the model is asked (ST-04 through the routes)", async () => {
    const who = await seedOwner(sql, app);
    faults.historyFails = true;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    await send(app, who, { message: "first" });
    const reading = attach(app, who);
    release();
    await gate;
    const { frames } = await reading;
    const types = frames.filter((f) => f.type !== "data-heartbeat").map((f) => f.type);
    expect(types).toContain("data-failed");
    expect(types.at(-1)).toBe("error");
    await untilIdle(who.conversationId);
    expect(script.count).toBe(0);
  });

  it("still answers when its place in the running list cannot be written (LS-06)", async () => {
    const who = await seedOwner(sql, app);
    faults.leaseFails = true;
    const res = await send(app, who, { message: "first" });
    expect(((await res.json()) as { data: { running: boolean } }).data.running).toBe(true);
    await untilIdle(who.conversationId);
    expect((await rowsOf(who.conversationId)).some((r) => r.role === "assistant")).toBe(true);
  });
});
