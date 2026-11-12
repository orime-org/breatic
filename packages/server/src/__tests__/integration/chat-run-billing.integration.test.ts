// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What a run is charged under, with payments on, on a real Redis and
 * database (inner#1717).
 *
 * A run is charged once, under its turn's key, however many messages it took
 * in and however many segments it ran. A run that answers an opening row a
 * dead or failed run wrote is charged under a key of its own, since that run
 * may have been charged already; a card's run keeps the key it always had.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, inject, vi } from "vitest";

/** Per model call, by its index: a hold, and what it says. */
const script = vi.hoisted(() => ({
  at: [] as Array<{ hold?: Promise<void>; parts?: () => unknown[] } | undefined>,
  count: 0,
}));

/** Output tokens each prose call reports: enough that every call costs well above the smallest charge. */
const SPENT = vi.hoisted(() => 200_000);

/** Hooks into the reply's persist; pass-through by default. */
const gate = vi.hoisted(() => ({
  persist: undefined as undefined | (() => Promise<void> | void),
}));

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  const { MockLanguageModelV4 } = await import("ai/test");
  const { saying, finishedSpending } = await import("../helpers/model-double.js");
  return {
    ...actual,
    resolveProvider: () => "test",
    getModel: () =>
      new MockLanguageModelV4({
        doStream: async (asked) => {
          const step = script.at[script.count++];
          if (step?.hold !== undefined) {
            await Promise.race([
              step.hold,
              new Promise<void>((resolve) => asked.abortSignal?.addEventListener("abort", () => resolve())),
            ]);
          }
          const parts = step?.parts?.() ?? [...saying("hi").slice(0, -1), finishedSpending(SPENT)];
          return {
            stream: new ReadableStream({
              start(controller) {
                // A call stopped while it was answering reports nothing, as a
                // provider's aborted response does.
                if (asked.abortSignal?.aborted !== true) for (const p of parts) controller.enqueue(p as never);
                controller.close();
              },
            }),
          };
        },
      }),
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

import type * as DomainModule from "@breatic/domain";
import type * as MessageRepoModule from "@server/modules/conversation/conversation-message.repo.js";
import crypto from "node:crypto";
import postgres from "postgres";
import { getRedis, initCore, loadLocales, sessionCookieName, setSession } from "@breatic/core";
import { creditLotService } from "@breatic/domain";
import type { Hono } from "hono";
import { FINISHED_ASKING_FOR_A_TOOL } from "../helpers/model-double.js";
import { stopChannel } from "@server/agent/chat-run.js";
import { markShuttingDown, resetShutdownFlagForTests } from "@server/agent/shutdown-flag.js";
import { openPaymentSource } from "./payment-source.js";
import { attach, keysOf, send, stop, sync, until, untilIdle, type Seeded } from "./chat-run-harness.js";

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
  resetShutdownFlagForTests();
  script.at = [];
  script.count = 0;
  gate.persist = undefined;
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
 * An owner with a project, an open conversation and credits to spend.
 * @returns The ids and cookie a request needs.
 */
async function seedPaying(): Promise<Seeded> {
  const tag = `run-bill-${crypto.randomBytes(4).toString("hex")}`;
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
  const sourceId = await openPaymentSource(sql);
  const [payment] = await sql<{ id: string }[]>`
    INSERT INTO payments (id, user_id, amount_cents, status, credits_granted)
    VALUES (${sourceId}, ${user!.id}, 1000, 'completed', 100000) RETURNING id
  `;
  const lot = await creditLotService.grantFromPayment({ paymentId: payment!.id, userId: user!.id, purchasedCredits: 100000 });
  await sql`UPDATE credit_lots SET designated_studio_id = ${studio!.id} WHERE id = ${lot.id}`;
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, user!.id);
  const cookie = `${sessionCookieName()}=${token}`;
  const opened = await app.request("/api/v1/chat/open", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: project!.id }),
  });
  const conversationId = ((await opened.json()) as { data: { current: { conversation: { id: string } } } }).data.current.conversation.id;
  return { userId: user!.id, projectId: project!.id, conversationId, cookie };
}

/**
 * Every charge requested for a conversation's runs, oldest first.
 * @param who - Whose.
 * @returns Each request's key and amount.
 */
async function chargesOf(who: Seeded): Promise<Array<{ key: string; amount: number }>> {
  const rows = await sql<{ reference_id: string; amount: string }[]>`
    SELECT reference_id, amount::text AS amount FROM credit_charge_requests
    WHERE kind = 'operation' AND actor_user_id = ${who.userId} AND reference_id LIKE ${`turn:${who.conversationId}:%`}
    ORDER BY created_at
  `;
  return rows.map((r) => ({ key: r.reference_id, amount: Number(r.amount) }));
}

/**
 * The turn a stored row is in.
 * @param id - The row.
 * @returns Its turn index.
 */
async function turnOf(id: string): Promise<number> {
  const [row] = await sql<{ turn_index: number }[]>`SELECT turn_index FROM conversation_messages WHERE id = ${id}`;
  return row!.turn_index;
}

/**
 * The run that holds a conversation now.
 * @param who - Whose.
 * @returns Its id.
 */
async function activeRun(who: Seeded): Promise<string> {
  return (await getRedis().get(keysOf(who.conversationId).active))!;
}

/**
 * What one model call of plain prose is charged, measured on a run of its own.
 * @returns The amount.
 */
async function oneCallCosts(): Promise<number> {
  const who = await seedPaying();
  await send(app, who, { message: "measure" });
  await untilIdle(who.conversationId);
  const charges = await chargesOf(who);
  expect(charges).toHaveLength(1);
  script.count = 0;
  return charges[0]!.amount;
}

describe("a run opened by a message", () => {
  it("is charged once, under its opening's turn (BL-01)", async () => {
    const who = await seedPaying();
    const id = crypto.randomUUID();
    await send(app, who, { id, message: "hello" });
    await untilIdle(who.conversationId);
    const charges = await chargesOf(who);
    expect(charges.map((c) => c.key)).toEqual([`turn:${who.conversationId}:${String(await turnOf(id))}`]);
    expect(charges[0]!.amount).toBeGreaterThan(0);
  });

  it("is charged once for every segment and every call, however many messages it took in (BL-02)", async () => {
    const single = await oneCallCosts();
    const who = await seedPaying();
    const first = held();
    script.at = [{ hold: first.promise }];
    const id = crypto.randomUUID();
    await send(app, who, { id, message: "hello" });
    await until(() => script.count >= 1);
    await send(app, who, { message: "and this" });
    await send(app, who, { message: "and that" });
    first.release();
    await untilIdle(who.conversationId);
    expect(script.count).toBe(2);
    const charges = await chargesOf(who);
    expect(charges.map((c) => c.key)).toEqual([`turn:${who.conversationId}:${String(await turnOf(id))}`]);
    // Two calls' worth: the turn rounds its total up once.
    expect(charges[0]!.amount).toBeGreaterThan(single * 1.9);
    expect(charges[0]!.amount).toBeLessThanOrEqual(single * 2);
  });

  it("is charged under the next message's own turn when the end of the run before opened it (BL-08)", async () => {
    const who = await seedPaying();
    const first = held();
    script.at = [{ hold: first.promise }];
    await send(app, who, { message: "first" });
    await until(() => script.count >= 1);
    const m2 = crypto.randomUUID();
    await send(app, who, { id: m2, message: "second" });
    const reading = attach(app, who);
    await new Promise((r) => setTimeout(r, 50));
    await stop(app, who);
    await reading;
    first.release();
    await untilIdle(who.conversationId);
    const keys = (await chargesOf(who)).map((c) => c.key);
    expect(keys).toContain(`turn:${who.conversationId}:${String(await turnOf(m2))}`);
    expect(keys.some((k) => k.includes(":run:"))).toBe(false);
  });

  it("charges the calls a shutdown did not stop, once (BL-09)", async () => {
    const single = await oneCallCosts();
    const who = await seedPaying();
    const first = held();
    const second = held();
    script.at = [{ hold: first.promise }, { hold: second.promise }];
    const id = crypto.randomUUID();
    await send(app, who, { id, message: "hello" });
    await until(() => script.count >= 1);
    await send(app, who, { message: "more" });
    first.release();
    await until(() => script.count >= 2);
    markShuttingDown();
    await untilIdle(who.conversationId);
    second.release();
    expect(script.count).toBe(2);
    const charges = await chargesOf(who);
    expect(charges.map((c) => c.key)).toEqual([`turn:${who.conversationId}:${String(await turnOf(id))}`]);
    expect(charges[0]!.amount).toBeCloseTo(single, 6);
  });
});

describe("a run that answers an opening row another run wrote", () => {
  it("is charged under a key of its own when the run before was charged but failed to store its reply (BL-03)", async () => {
    const who = await seedPaying();
    let failed = false;
    gate.persist = () => {
      if (failed) return;
      failed = true;
      throw new Error("database write failed");
    };
    const id = crypto.randomUUID();
    await send(app, who, { id, message: "hello" });
    await untilIdle(who.conversationId);
    const n = await turnOf(id);
    expect((await chargesOf(who)).map((c) => c.key)).toEqual([`turn:${who.conversationId}:${String(n)}`]);
    const before = (await chargesOf(who))[0]!.amount;
    await sync(app, who);
    const r2 = await activeRun(who);
    await untilIdle(who.conversationId);
    const charges = await chargesOf(who);
    expect(charges).toEqual([
      { key: `turn:${who.conversationId}:${String(n)}`, amount: before },
      { key: `turn:${who.conversationId}:${String(n)}:run:${r2}`, amount: expect.any(Number) },
    ]);
    const replies = await sql`SELECT 1 FROM conversation_messages WHERE conversation_id = ${who.conversationId} AND role = 'assistant' AND turn_index = ${n}`;
    expect(replies).toHaveLength(1);
  });

  it("is charged under a key of its own when the run before died between its charge and its reply (BL-04)", async () => {
    const who = await seedPaying();
    const stuck = held();
    let first = true;
    gate.persist = () => {
      if (!first) return;
      first = false;
      return stuck.promise.then(() => {
        throw new Error("the process died");
      });
    };
    const id = crypto.randomUUID();
    await send(app, who, { id, message: "hello" });
    const n = await turnOf(id);
    await until(async () => (await chargesOf(who)).length === 1);
    // The process holding the run is gone: its lease runs out.
    await getRedis().del(keysOf(who.conversationId).active);
    await sync(app, who);
    const r2 = await activeRun(who);
    await untilIdle(who.conversationId);
    stuck.release();
    expect((await chargesOf(who)).map((c) => c.key)).toEqual([
      `turn:${who.conversationId}:${String(n)}`,
      `turn:${who.conversationId}:${String(n)}:run:${r2}`,
    ]);
  });

  it("is the only charge when the run before died before it was charged (BL-05)", async () => {
    const who = await seedPaying();
    const stuck = held();
    script.at = [{ hold: stuck.promise }];
    const id = crypto.randomUUID();
    await send(app, who, { id, message: "hello" });
    await until(() => script.count >= 1);
    const r1 = await activeRun(who);
    await getRedis().del(keysOf(who.conversationId).active);
    await sync(app, who);
    const r2 = await activeRun(who);
    await untilIdle(who.conversationId);
    expect((await chargesOf(who)).map((c) => c.key)).toEqual([`turn:${who.conversationId}:${String(await turnOf(id))}:run:${r2}`]);
    await getRedis().publish(stopChannel(r1), "stop");
    stuck.release();
  });

  it("keeps its own key across a second segment of the same reply (BL-06)", async () => {
    const who = await seedPaying();
    let failed = false;
    gate.persist = () => {
      if (failed) return;
      failed = true;
      throw new Error("database write failed");
    };
    const id = crypto.randomUUID();
    await send(app, who, { id, message: "hello" });
    await untilIdle(who.conversationId);
    const segment = held();
    script.at = [undefined, { hold: segment.promise }];
    await sync(app, who);
    const r2 = await activeRun(who);
    await until(() => script.count >= 2);
    await send(app, who, { message: "one more" });
    segment.release();
    await untilIdle(who.conversationId);
    expect(script.count).toBe(3);
    const n = await turnOf(id);
    expect((await chargesOf(who)).map((c) => c.key)).toEqual([
      `turn:${who.conversationId}:${String(n)}`,
      `turn:${who.conversationId}:${String(n)}:run:${r2}`,
    ]);
  });
});

describe("a run opened by a card's answer", () => {
  it("is charged under the key every answered card is (BL-07)", async () => {
    const who = await seedPaying();
    script.at = [
      {
        parts: () => [
          {
            type: "tool-call",
            toolCallId: "bl-ask",
            toolName: "ask_user",
            input: JSON.stringify({ questions: [{ header: "Ratio", question: "Which ratio?", options: [{ label: "16:9" }, { label: "9:16" }] }] }),
          },
          FINISHED_ASKING_FOR_A_TOOL,
        ],
      },
    ];
    const id = crypto.randomUUID();
    await send(app, who, { id, message: "ask me" });
    await untilIdle(who.conversationId);
    const res = await app.request("/api/v1/chat/message", {
      method: "POST",
      headers: { Cookie: who.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "",
        project_id: who.projectId,
        conversation_id: who.conversationId,
        answer: { toolCallId: "bl-ask", answers: [{ index: 0, selected: ["9:16"] }] },
      }),
    });
    expect(res.status).toBe(200);
    await untilIdle(who.conversationId);
    const n = await turnOf(id);
    expect((await chargesOf(who)).map((c) => c.key)).toEqual([
      `turn:${who.conversationId}:${String(n)}`,
      `turn:${who.conversationId}:${String(n)}:answer:bl-ask`,
    ]);
  });
});
