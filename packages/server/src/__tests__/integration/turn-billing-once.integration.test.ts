// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * A turn is charged for once, and two turns are charged for separately.
 *
 * Both halves are about the same string. Billing is made idempotent by a key
 * built from the conversation and the turn's number in it, so a retry on the
 * same turn settles once — and two different turns must not produce the same
 * key, or one of them is charged and the other is free.
 *
 * The two failures are opposites and neither shows up without a real database:
 *
 *   - the key repeating when it should not. Turn numbers used to be read and
 *     written in two separately committed statements, so two messages arriving
 *     together could compute the same number. What that costs is not a
 *     duplicate charge but a missing one: the second turn's key collides with
 *     the first's, the lock says "already settled", and it runs for free.
 *   - the key not holding when it should. The lock lives in Redis, so a stub
 *     would only ever prove what the stub does.
 *
 * Payments are turned on for this suite. They default off, and with them off
 * `deduct` records the ledger row but leaves the balance alone — which would
 * make "the balance moved exactly once" unobservable, the half of this that
 * money actually depends on. `initCore` simply replaces the held config, so
 * the switch is flipped here and put back afterwards.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";
import fc from "fast-check";

// `ai` is stubbed: the real SDK is replaced with a double that reaches no
// network, so this suite needs no API key and the SDK stays out of its module
// graph. Its stream reports one finished step, because a turn that consumed
// nothing owes nothing and would settle no ledger row to count.
vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {
      yield { type: "text-delta", text: "hi" };
      yield { type: "finish-step", usage: { totalTokens: 1000 } };
    })(),
    text: Promise.resolve("hi"),
    usage: Promise.resolve({ totalTokens: 1000 }),
    totalUsage: Promise.resolve({ totalTokens: 1000 }),
  }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

import crypto from "node:crypto";
import postgres from "postgres";
import {
  initCore,
  getRedis,
  setSession,
  sessionCookieName,
  loadLocales,
} from "@breatic/core";
import { creditService } from "@breatic/domain";
import type { Hono } from "hono";

const PG_DRIVER_LOCAL = "turn-billing-once-test-driver";

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  // The Stripe secrets come with the switch: the config refuses to turn
  // payments on without them, because a webhook that cannot verify its
  // signature fails confusingly later instead of clearly here. Nothing in this
  // suite reaches Stripe — the deduction path is entirely our own database and
  // Redis — so placeholders satisfy the check without standing in for a key.
  initCore({
    ...process.env,
    PAYMENT_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
    STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
  });
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), {
    max: 6,
    prepare: false,
    connection: { application_name: PG_DRIVER_LOCAL },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  // Put the switch back, so a suite sharing this worker sees what it expects.
  initCore(process.env);
});

let seq = 0;

/** A signed-in owner with a project, an open conversation and money. */
interface Seeded {
  userId: string;
  projectId: string;
  conversationId: string;
  cookie: string;
}

/**
 * Seed one owner with a project, a conversation and a starting balance.
 * @param balance - Credits to open the account with.
 * @returns The ids and cookie a request needs.
 */
async function seed(balance = 100_000): Promise<Seeded> {
  const tag = `bill-${seq++}-${crypto.randomBytes(3).toString("hex")}`;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`${tag}@example.com`}, true) RETURNING id
  `;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`${tag}-studio`}, 'team', ${tag}) RETURNING id
  `;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${user!.id}, 'admin')
  `;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug, visibility)
    VALUES (${studio!.id}, ${user!.id}, ${tag}, ${`${tag}-p`}, 'private') RETURNING id
  `;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${project!.id}, ${user!.id}, 'owner', null)
  `;
  await sql`
    INSERT INTO credit_balances (user_id, balance) VALUES (${user!.id}, ${balance})
    ON CONFLICT (user_id) DO UPDATE SET balance = ${balance}
  `;

  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, user!.id);
  const cookie = `${sessionCookieName()}=${token}`;

  const opened = await app.request("/api/v1/chat/open", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: project!.id }),
  });
  const body = (await opened.json()) as {
    data: { current: { conversation: { id: string } } };
  };
  const conversationId = body.data.current.conversation.id;
  expect(conversationId).not.toBe("");

  return { userId: user!.id, projectId: project!.id, conversationId, cookie };
}

/**
 * Read every settlement recorded against a user, newest last.
 * @param userId - Whose ledger to read.
 * @returns The reference keys of the deductions found.
 */
async function settlementsFor(userId: string): Promise<string[]> {
  const rows = await sql<{ reference_id: string }[]>`
    SELECT reference_id FROM credit_transactions
    WHERE user_id = ${userId} AND tx_type = 'deduct'
    ORDER BY created_at
  `;
  return rows.map((r) => r.reference_id);
}

describe("turn numbers do not collide", () => {
  it("gives every concurrent message its own number", async () => {
    // Where the collision actually lives, and the only level it can be forced
    // at. Two requests through the route do interleave, but not reliably
    // inside the few statements that matter — measured: removing the lock
    // leaves the route-level test below green, so that test alone would guard
    // nothing. Eight callers arriving at once on the same conversation is what
    // makes the window wide enough to hit every time.
    const { conversationId } = await seed();
    const { addMessage } = await import(
      "@server/modules/conversation/conversation-message.repo.js"
    );

    const assigned = await Promise.all(
      Array.from({ length: 8 }, (_unused, i) =>
        addMessage(conversationId, { role: "user", content: `message ${i}` }),
      ),
    );

    // Every one distinct: the number is half of the billing key, so two turns
    // sharing one means the second settles against the first's key and runs
    // for free.
    expect(new Set(assigned).size).toBe(assigned.length);
  }, 60_000);
});

describe("two turns in one conversation are billed apart", () => {
  it("gives concurrent turns different settlement keys", async () => {
    // Two messages sent together, the shape that used to collide: both turns
    // read the conversation's highest turn number before either had written
    // its own.
    const { userId, projectId, conversationId, cookie } = await seed();
    const send = (): Promise<Response> =>
      app.request("/api/v1/chat/message", {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "hello",
          project_id: projectId,
          conversation_id: conversationId,
        }),
      });

    const responses = await Promise.all([send(), send()]);
    for (const res of responses) {
      expect(res.status).toBe(200);
      // Drain: the turn's work, including its settlement, happens as the
      // stream is consumed.
      await res.text();
    }

    const keys = await settlementsFor(userId);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    for (const key of keys) {
      expect(key).toMatch(new RegExp(`^turn:${conversationId}:\\d+$`));
    }
  }, 60_000);
});

describe("one turn is settled once, however many times it is asked for", () => {
  it("moves the balance once and records one row, for any sequence of calls", async () => {
    const { userId } = await seed(50_000);

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 50 }),
        async (sequentialCalls, concurrentCalls, amount) => {
          // A key of its own per run, so runs cannot settle each other's turn.
          const refKey = `turn:${crypto.randomUUID()}:1`;
          const [before] = await sql<{ balance: number }[]>`
            SELECT balance FROM credit_balances WHERE user_id = ${userId}
          `;

          for (let i = 0; i < sequentialCalls; i++) {
            await creditService.deductOnce(userId, refKey, amount, "Agent chat", {
              tokensUsed: 1000,
            });
          }
          await Promise.all(
            Array.from({ length: concurrentCalls }, () =>
              creditService.deductOnce(userId, refKey, amount, "Agent chat", {
                tokensUsed: 1000,
              }),
            ),
          );

          const rows = await sql<{ n: string }[]>`
            SELECT count(*) AS n FROM credit_transactions WHERE reference_id = ${refKey}
          `;
          const [after] = await sql<{ balance: number }[]>`
            SELECT balance FROM credit_balances WHERE user_id = ${userId}
          `;

          expect(Number(rows[0]!.n)).toBe(1);
          expect(after!.balance).toBe(before!.balance - amount);
        },
      ),
      { numRuns: 15 },
    );
  }, 120_000);
});
