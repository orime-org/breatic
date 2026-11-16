// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the chat routes answer about a balance that cannot pay, with payments
 * on, on a real Redis and database (inner#1717).
 *
 * A send and a card's answer are refused 402 before anything is written. A
 * sync that would open a run for what waits says the balance is why it did
 * not; a sync with nothing to open says nothing about the balance. Once the
 * balance can pay, what waited longest opens the run.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, inject, vi } from "vitest";

const script = vi.hoisted(() => ({ hold: undefined as Promise<void> | undefined, count: 0 }));

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  const { assemblyProvider, fakeProvider } = await import("../helpers/fake-provider.js");
  actual.initProvider(assemblyProvider());
  const { MockLanguageModelV4 } = await import("ai/test");
  const { saying, FINISHED_ASKING_FOR_A_TOOL } = await import("../helpers/model-double.js");
  return {
    ...actual,
    provider: fakeProvider(() =>
      new MockLanguageModelV4({
        doStream: async (asked) => {
          const i = script.count++;
          if (script.hold !== undefined) {
            await Promise.race([script.hold, new Promise<void>((r) => asked.abortSignal?.addEventListener("abort", () => r()))]);
          }
          // The first call of a conversation that asks for a card asks; every other call talks.
          const parts = (asked.prompt as unknown[]).some((m) => JSON.stringify(m).includes("ask me")) && i === 0
            ? [
              {
                type: "tool-call",
                toolCallId: "cr-ask",
                toolName: "ask_user",
                input: JSON.stringify({ questions: [{ header: "Ratio", question: "Which ratio?", options: [{ label: "16:9" }, { label: "9:16" }] }] }),
              },
              FINISHED_ASKING_FOR_A_TOOL,
            ]
            : saying("hi");
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

import type * as DomainModule from "@breatic/domain";
import crypto from "node:crypto";
import postgres from "postgres";
import { getRedis, initCore, loadLocales, sessionCookieName, setSession } from "@breatic/core";
import { creditLotService } from "@breatic/domain";
import type { Hono } from "hono";
import { openPaymentSource } from "./payment-source.js";
import { keysOf, send, sync, until, untilIdle, type Seeded } from "./chat-run-harness.js";

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  // Placeholders satisfy the config's check; nothing here reaches Stripe.
  initCore({
    ...process.env,
    PAYMENT_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
    STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
  });
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 6, prepare: false });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  initCore(process.env);
});

afterEach(() => {
  script.hold = undefined;
  script.count = 0;
});

/**
 * An owner with a project and an open conversation, and a studio balance.
 * @param credits - What the studio can spend; 0 grants nothing.
 * @returns The ids, the cookie and the studio's lot, if any.
 */
async function seedOwner(credits: number): Promise<Seeded & { lotId?: string }> {
  const tag = `run-credit-${crypto.randomBytes(4).toString("hex")}`;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`${tag}@example.com`}, true) RETURNING id
  `;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name) VALUES (${user!.id}, ${`${tag}-s`}, 'team', ${tag}) RETURNING id
  `;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${user!.id}, 'admin')`;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug) VALUES (${studio!.id}, ${user!.id}, ${tag}, ${`${tag}-p`}) RETURNING id
  `;
  await sql`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${project!.id}, ${user!.id}, 'owner', null)`;
  let lotId: string | undefined;
  if (credits > 0) {
    const sourceId = await openPaymentSource(sql);
    const [payment] = await sql<{ id: string }[]>`
      INSERT INTO payments (id, user_id, amount_cents, status, credits_granted)
      VALUES (${sourceId}, ${user!.id}, 1000, 'completed', ${credits}) RETURNING id
    `;
    const lot = await creditLotService.grantFromPayment({ paymentId: payment!.id, userId: user!.id, purchasedCredits: credits });
    await sql`UPDATE credit_lots SET designated_studio_id = ${studio!.id} WHERE id = ${lot.id}`;
    lotId = lot.id;
  }
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, user!.id);
  const cookie = `${sessionCookieName()}=${token}`;
  const opened = await app.request("/api/v1/chat/open", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: project!.id }),
  });
  const conversationId = ((await opened.json()) as { data: { current: { conversation: { id: string } } } }).data.current.conversation.id;
  return { userId: user!.id, projectId: project!.id, conversationId, cookie, ...(lotId === undefined ? {} : { lotId }) };
}

/**
 * Spend a studio's whole balance.
 * @param lotId - Its one lot.
 */
async function drain(lotId: string): Promise<void> {
  await sql`UPDATE credit_lots SET remaining_credits = 0 WHERE id = ${lotId}`;
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

/** What a sync answered. */
interface Synced {
  pending: Array<{ id: string }>;
  running: boolean;
  awaiting: boolean;
  blocked?: string;
}

/**
 * Sync and read the answer.
 * @param who - Whose conversation.
 * @returns The answer's data.
 */
async function synced(who: Seeded): Promise<Synced> {
  return ((await (await sync(app, who)).json()) as { data: Synced }).data;
}

describe("a send the balance cannot pay for", () => {
  it("is refused 402 and leaves the queue and its ids alone (RT-06)", async () => {
    const who = await seedOwner(0);
    const before = await snapshotOf(who.conversationId);
    const id = crypto.randomUUID();
    const res = await send(app, who, { id, message: "hello" });
    expect(res.status).toBe(402);
    expect(await snapshotOf(who.conversationId)).toEqual(before);
    expect(await getRedis().sismember(keysOf(who.conversationId).ids, id)).toBe(0);
  });

  it("opens with what waited longest once the balance can pay, and lists only the new message as waiting (RT-03b)", async () => {
    const who = await seedOwner(100_000);
    const m0 = crypto.randomUUID();
    await getRedis().rpush(keysOf(who.conversationId).queue, itemOf(who, m0));
    const { promise, release } = (() => {
      let r!: () => void;
      return { promise: new Promise<void>((resolve) => (r = resolve)), release: () => r() };
    })();
    script.hold = promise;
    const m1 = crypto.randomUUID();
    const body = ((await (await send(app, who, { id: m1, message: "now" })).json()) as { data: { status: string; pending: Array<{ id: string }> } }).data;
    expect(body.status).toBe("start");
    expect(body.pending.map((p) => p.id)).toEqual([m1]);
    release();
    await untilIdle(who.conversationId);
  });
});

describe("a sync while the balance cannot pay", () => {
  for (const waits of ["queue", "taken"] as const) {
    it(`says the balance is why no run opened for what is ${waits === "queue" ? "queued" : "left taken"} (RT-12)`, async () => {
      const who = await seedOwner(0);
      await getRedis().rpush(keysOf(who.conversationId)[waits], itemOf(who, crypto.randomUUID()));
      expect(await synced(who)).toMatchObject({ blocked: "credits", running: false });
      expect(await getRedis().exists(keysOf(who.conversationId).active)).toBe(0);
    });
  }

  it("says nothing about the balance when there is nothing to open (RT-13)", async () => {
    const who = await seedOwner(0);
    expect((await synced(who)).blocked).toBeUndefined();
  });

  it("says nothing about the balance while a run holds the conversation (RT-13)", async () => {
    const who = await seedOwner(0);
    await getRedis().set(keysOf(who.conversationId).active, "R-running");
    await getRedis().rpush(keysOf(who.conversationId).queue, itemOf(who, crypto.randomUUID()));
    expect((await synced(who)).blocked).toBeUndefined();
    await getRedis().del(...Object.values(keysOf(who.conversationId)));
  });

  it("says nothing about the balance while a card waits (RT-13)", async () => {
    const who = await seedOwner(0);
    await getRedis().set(keysOf(who.conversationId).awaiting, "T-waiting");
    await getRedis().rpush(keysOf(who.conversationId).queue, itemOf(who, crypto.randomUUID()));
    expect((await synced(who)).blocked).toBeUndefined();
    await getRedis().del(...Object.values(keysOf(who.conversationId)));
  });
});

describe("a card's answer the balance cannot pay for", () => {
  it("is refused 402 with the card still waiting (RT-18)", async () => {
    const who = await seedOwner(100_000);
    await send(app, who, { message: "ask me" });
    await untilIdle(who.conversationId);
    await until(async () => (await getRedis().get(keysOf(who.conversationId).awaiting)) === "cr-ask");
    await drain(who.lotId!);
    const res = await app.request("/api/v1/chat/message", {
      method: "POST",
      headers: { Cookie: who.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "",
        project_id: who.projectId,
        conversation_id: who.conversationId,
        answer: { toolCallId: "cr-ask", answers: [{ index: 0, selected: ["9:16"] }] },
      }),
    });
    expect(res.status).toBe(402);
    expect(await getRedis().get(keysOf(who.conversationId).awaiting)).toBe("cr-ask");
    const [row] = await sql<{ parts: Array<{ toolCallId?: string; status?: string }> }[]>`
      SELECT parts FROM conversation_messages WHERE conversation_id = ${who.conversationId} AND role = 'assistant' ORDER BY created_at DESC LIMIT 1
    `;
    expect(row!.parts.find((p) => p.toolCallId === "cr-ask")?.status).toBe("awaiting");
  });
});
