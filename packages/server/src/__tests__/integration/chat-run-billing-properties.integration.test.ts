// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the runs that answer one opening are charged under, whatever crashes
 * come between, on a real Redis and database with payments on (inner#1717,
 * PB-05 of the test spec).
 *
 * Each case sends one message; the run it opens, and each run a sync opens
 * after a crash, may die at one of the spec's crash points: before the
 * opening row is written, inside the model call (before it is charged),
 * between the charge and the reply, between the reply and the ack, or
 * between the ack and the settle. A crash leaves the run stuck where it is,
 * forever, and deletes `active`, which is what a lease running out looks
 * like. After 0 to 3 crashes the opening is answered by a run that is let
 * through, or was already answered by the crash's run.
 *
 * The run that writes the opening row is charged under the turn's key; every
 * later run that reuses the row is charged under a key of its own; a run
 * that never finished a model call is charged nothing.
 */
import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

/** The crash points a run may die at. */
type CrashPoint = "beforeOpening" | "inModelCall" | "billToReply" | "replyToAck" | "ackToSettle";

/** The crash the next run is to die at, and whether it got there. */
const gate = vi.hoisted(() => ({
  mode: null as null | string,
  reached: false,
}));

/** Output tokens each call reports: enough that every call costs well above the smallest charge. */
const SPENT = vi.hoisted(() => 200_000);

/** What each call costs, as the test model reports it to provider: well above the smallest charge. */
const CALL_USD = vi.hoisted(() => 1);

/**
 * Whether this is the crash the run is to die at; arms nothing further once it is.
 * @param point - The crash point being passed.
 * @returns True when the run dies here.
 */
const dieHere = vi.hoisted(() => (point: string): boolean => {
  if (gate.mode !== point) return false;
  gate.mode = null;
  gate.reached = true;
  return true;
});

/**
 * A wait that never ends: where a dead run stays.
 * @returns A promise that never settles.
 */
const forever = vi.hoisted(() => (): Promise<never> => new Promise<never>(() => {}));

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  const { assemblyProvider, fakeProvider } = await import("../helpers/fake-provider.js");
  actual.initProvider(assemblyProvider());
  const { MockLanguageModelV4 } = await import("ai/test");
  const { saying, finishedSpending } = await import("../helpers/model-double.js");
  return {
    ...actual,
    provider: fakeProvider(() =>
      new MockLanguageModelV4({
        doStream: async () => {
          if (dieHere("inModelCall")) await forever();
          const parts = [...saying("hi").slice(0, -1), { ...finishedSpending(SPENT), providerMetadata: { test: { costUsd: CALL_USD } } }];
          return {
            stream: new ReadableStream({
              start(controller) {
                for (const p of parts) controller.enqueue(p);
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
    addUserMessage: async (...args: Parameters<typeof actual.addUserMessage>) => {
      if (dieHere("beforeOpening")) await forever();
      return actual.addUserMessage(...args);
    },
    addMessage: async (...args: Parameters<typeof actual.addMessage>) => {
      if (args[1].role !== "assistant") return actual.addMessage(...args);
      if (dieHere("billToReply")) await forever();
      const stored = await actual.addMessage(...args);
      if (dieHere("replyToAck")) await forever();
      return stored;
    },
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
        settle: async (...args: Parameters<typeof real.settle>) => {
          if (dieHere("ackToSettle")) await forever();
          return real.settle(...args);
        },
      };
    },
  };
});

import type * as DomainModule from "@breatic/domain";
import type * as MessageRepoModule from "@server/modules/conversation/conversation-message.repo.js";
import type * as QueueModule from "@server/modules/chat-queue/chat-queue.service.js";
import crypto from "node:crypto";
import fc from "fast-check";
import postgres from "postgres";
import { getRedis, initCore, loadLocales, sessionCookieName, setSession } from "@breatic/core";
import { creditLotService } from "@breatic/domain";
import type { Hono } from "hono";
import { runObservers } from "@server/agent/chat-run.js";
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

/**
 * An owner with a project, an open conversation and credits to spend.
 * @returns The ids and cookie a request needs.
 */
async function seedPaying(): Promise<Seeded> {
  const tag = `pb05-${crypto.randomBytes(4).toString("hex")}`;
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

/** A crash point that comes after the reply is stored: the opening is answered by the run that died there. */
const AFTER_REPLY: ReadonlySet<CrashPoint> = new Set<CrashPoint>(["replyToAck", "ackToSettle"]);

const crashesArb = fc.array(
  fc.constantFrom<CrashPoint>("beforeOpening", "inModelCall", "billToReply", "replyToAck", "ackToSettle"),
  { maxLength: 3 },
);

describe("the runs that answer one opening, across crashes (inner#1717)", () => {
  it("charge each run under exactly one key, once, and only runs whose model call finished (PB-05)", async () => {
    await fc.assert(
      fc.asyncProperty(crashesArb, async (drawn) => {
        // Once a crash's run has stored the reply, no later run reaches a crash point.
        const cut = drawn.findIndex((p) => AFTER_REPLY.has(p));
        const crashes = cut === -1 ? drawn : drawn.slice(0, cut + 1);
        const who = await seedPaying();
        const c = who.conversationId;
        const observed: string[] = [];
        const observe = async (run: { conversationId: string; runId: string }): Promise<void> => {
          if (run.conversationId === c) observed.push(run.runId);
        };
        runObservers.push(observe);
        try {
          const id = crypto.randomUUID();
          /**
           * Open the next run, armed to die at a crash point or let through. A
           * send or sync answers once the run's opening stage is done, which a
           * run that dies before its opening row never finishes, so that one
           * is left unanswered.
           * @param point - Where it dies; null lets it through.
           * @param open - The request that opens it.
           */
          const next = async (point: CrashPoint | null, open: () => Promise<Response>): Promise<void> => {
            gate.mode = point;
            gate.reached = false;
            const answered = open();
            if (point === "beforeOpening") void answered.catch(() => undefined);
            else expect((await answered).status).toBe(200);
          };
          await next(crashes[0] ?? null, () => send(app, who, { id, message: "hello" }));
          for (let i = 0; i < crashes.length; i += 1) {
            await until(() => gate.reached);
            await getRedis().del(keysOf(c).active);
            await next(crashes[i + 1] ?? null, () => sync(app, who));
          }
          await untilIdle(c);

          const [opening] = await sql<{ turn_index: number }[]>`SELECT turn_index FROM conversation_messages WHERE id = ${id}`;
          const n = String(opening!.turn_index);
          // Each attempt in order; the last is let through unless a crash's run already answered.
          const attempts: Array<CrashPoint | "through"> = cut === -1 ? [...crashes, "through"] : crashes;
          const expected: string[] = [];
          let row = false;
          let seen = 0;
          for (const a of attempts) {
            if (a === "beforeOpening") continue;
            const runId = observed[seen++];
            const key = row ? `turn:${c}:${n}:run:${String(runId)}` : `turn:${c}:${n}`;
            row = true;
            if (a !== "inModelCall") expected.push(key);
          }
          expect(observed).toHaveLength(seen);
          const charges = await chargesOf(who);
          expect({ crashes, keys: charges.map((x) => x.key) }).toEqual({ crashes, keys: expected });
          for (const charge of charges) expect(charge.amount).toBeGreaterThan(0);
          const replies = await sql`
            SELECT 1 FROM conversation_messages WHERE conversation_id = ${c} AND role = 'assistant' AND turn_index = ${opening!.turn_index}
          `;
          expect(replies).toHaveLength(1);
        } finally {
          runObservers.splice(runObservers.indexOf(observe), 1);
          gate.mode = null;
        }
      }),
      { numRuns: 100 },
    );
  }, 900_000);
});
