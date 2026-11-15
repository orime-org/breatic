// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The limits on the chat routes of inner#1717, on a real Redis and database.
 *
 * Sync, stop and taking a message back are each counted per user under
 * their own `config/rate-limits.yaml` entry; a request over the limit is
 * answered 429 and changes nothing, and sending a message counts against
 * none of the three. The limits are lowered here to two a window.
 */
import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

/** The three limits this file lowers. */
const LOWERED = vi.hoisted(() => new Set(["chat-sync", "chat-stop", "chat-queue-remove"]));

vi.mock("@server/config/rate-limits.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RateLimitsModule>();
  return {
    ...actual,
    getRateLimit: (action: string) => (LOWERED.has(action) ? { max: 2, windowSeconds: 60 } : actual.getRateLimit(action)),
  };
});

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  const { assemblyProvider, fakeProvider } = await import("../helpers/fake-provider.js");
  actual.initProvider(assemblyProvider());
  const { modelProducing, saying } = await import("../helpers/model-double.js");
  return { ...actual, provider: fakeProvider(() => modelProducing(() => saying("hi")) )};
});

import type * as DomainModule from "@breatic/domain";
import type * as RateLimitsModule from "@server/config/rate-limits.js";
import crypto from "node:crypto";
import postgres from "postgres";
import { getRedis, initCore, loadLocales } from "@breatic/core";
import type { Hono } from "hono";
import { keysOf, seedOwner, send, stop, sync, takeBack, untilIdle, type Seeded } from "./chat-run-harness.js";

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  try {
    initCore(process.env);
  } catch {
    // Already initialised by a sibling suite in this worker.
  }
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/**
 * Everything a conversation's five keys hold.
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

const ROUTES: Array<{ name: string; call: (who: Seeded, id: string) => Promise<Response> }> = [
  { name: "POST /chat/conversations/:id/sync", call: (who) => sync(app, who) },
  { name: "POST /chat/stop", call: (who) => stop(app, who) },
  { name: "DELETE /chat/conversations/:id/queue/:messageId", call: (who, id) => takeBack(app, who, id) },
];

describe("the chat routes' own limits", () => {
  for (const route of ROUTES) {
    it(`${route.name} answers 429 past its limit and changes nothing (RT-25)`, async () => {
      const who = await seedOwner(sql, app);
      const k = keysOf(who.conversationId);
      // A run holds the conversation and one message waits, so each route has something it could change.
      await getRedis().set(k.active, "R-running");
      const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
      for (const id of ids) {
        await getRedis().rpush(k.queue, JSON.stringify({ id, sentAt: new Date().toISOString(), userId: who.userId, acceptLanguage: "en", message: "m", attached_chips: [] }));
      }
      expect((await route.call(who, ids[0]!)).status).toBe(200);
      expect((await route.call(who, ids[1]!)).status).toBe(200);
      const before = await snapshotOf(who.conversationId);
      expect((await route.call(who, ids[2]!)).status).toBe(429);
      expect(await snapshotOf(who.conversationId)).toEqual(before);
      await getRedis().del(...Object.values(k));
    });
  }

  it("leaves sending a message out of all three (RT-25)", async () => {
    const who = await seedOwner(sql, app);
    for (let i = 0; i < 3; i++) {
      expect((await sync(app, who)).status).toBe(i < 2 ? 200 : 429);
    }
    for (let i = 0; i < 3; i++) {
      expect((await send(app, who, { message: `hello ${String(i)}` })).status).toBe(200);
      await untilIdle(who.conversationId);
    }
  });
});
