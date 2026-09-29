// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every paid call a chat turn makes leaves a row in `agent_usage_records`,
 * and what the turn is charged is what those rows add up to (#296).
 *
 * Real database and Redis: the rows and the ledger are the thing under test.
 * Payments are on, so the charge reaches a lot and a balance check has
 * something to refuse.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

let provider = "deepseek";
let finishMetadata: { openrouter: { usage: { cost: number } } } | undefined;

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  const { modelProducing, saying, finishing } = await import("../helpers/model-double.js");
  return {
    ...actual,
    resolveProvider: () => provider,
    getModel: () =>
      modelProducing(() => {
        const finish = finishing("stop", 1_000_000);
        const reported =
          finish.type === "finish" && finishMetadata !== undefined
            ? { ...finish, providerMetadata: finishMetadata }
            : finish;
        return [...saying("hi").filter((part) => part.type !== "finish"), reported];
      }),
  };
});

import type * as DomainModule from "@breatic/domain";
import crypto from "node:crypto";
import postgres from "postgres";
import { initCore, getRedis, setSession, sessionCookieName, loadLocales } from "@breatic/core";
import { creditLotService } from "@breatic/domain";
import type { Hono } from "hono";

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  initCore({
    ...process.env,
    PAYMENT_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
    STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
  });
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  initCore(process.env);
});

let seq = 0;

/**
 * Seed an owner with a project and an open conversation; a purchase only when asked.
 * @param credits - Credits to assign to the studio, or 0 for none.
 * @returns What a request needs.
 */
async function seed(credits: number): Promise<{
  userId: string;
  projectId: string;
  conversationId: string;
  cookie: string;
}> {
  const tag = `usage-${seq++}-${crypto.randomBytes(3).toString("hex")}`;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`${tag}@example.com`}, true) RETURNING id
  `;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`${tag}-studio`}, 'team', ${tag}) RETURNING id
  `;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${user!.id}, 'admin')`;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studio!.id}, ${user!.id}, ${tag}, ${`${tag}-p`}) RETURNING id
  `;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${project!.id}, ${user!.id}, 'owner', null)
  `;
  if (credits > 0) {
    const [source] = await sql<{ id: string }[]>`
      INSERT INTO credit_sources (id, kind) VALUES (gen_random_uuid(), 'payment') RETURNING id
    `;
    const [payment] = await sql<{ id: string }[]>`
      INSERT INTO payments (id, user_id, amount_cents, status, credits_granted)
      VALUES (${source!.id}, ${user!.id}, 1000, 'completed', ${credits}) RETURNING id
    `;
    const lot = await creditLotService.grantFromPayment({
      paymentId: payment!.id,
      userId: user!.id,
      purchasedCredits: credits,
    });
    await sql`UPDATE credit_lots SET designated_studio_id = ${studio!.id} WHERE id = ${lot.id}`;
  }
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, user!.id);
  const cookie = `${sessionCookieName()}=${token}`;
  const opened = await app.request("/api/v1/chat/open", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: project!.id }),
  });
  const body = (await opened.json()) as { data: { current: { conversation: { id: string } } } };
  return { userId: user!.id, projectId: project!.id, conversationId: body.data.current.conversation.id, cookie };
}

/**
 * Send one message and drain the stream.
 * @param seeded - Who sends, and where.
 * @returns The response status.
 */
async function send(seeded: Awaited<ReturnType<typeof seed>>): Promise<number> {
  const res = await app.request("/api/v1/chat/message", {
    method: "POST",
    headers: { Cookie: seeded.cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "hello",
      project_id: seeded.projectId,
      conversation_id: seeded.conversationId,
    }),
  });
  await res.text();
  return res.status;
}

describe("a chat turn's model calls are recorded and charged at their cost", () => {
  it("prices a direct DeepSeek call from the table and charges exactly the row", async () => {
    provider = "deepseek";
    finishMetadata = undefined;
    const seeded = await seed(100_000);
    expect(await send(seeded)).toBe(200);

    const rows = await sql<
      { operation_key: string; feature: string; source: string; cost_usd: string; cost_source: string; credits: string; output_tokens: number }[]
    >`SELECT * FROM agent_usage_records WHERE actor_user_id = ${seeded.userId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.operation_key).toMatch(new RegExp(`^turn:${seeded.conversationId}:\\d+$`));
    expect(rows[0]).toMatchObject({ feature: "chat_turn", source: "model", cost_source: "price_table", output_tokens: 1_000_000 });
    // One uncached input token at 1.32/M plus a million output tokens at 3.96/M.
    expect(Number(rows[0]!.cost_usd)).toBeCloseTo(3.96 + 1.32 / 1_000_000, 6);

    const [spent] = await sql<{ total: string }[]>`
      SELECT COALESCE(SUM(amount), 0)::text AS total FROM credit_ledger
      WHERE reference_id = ${rows[0]!.operation_key} AND entry_type = 'spend'
    `;
    expect(Number(spent!.total)).toBeCloseTo(-Number(rows[0]!.credits), 4);
  }, 60_000);

  it("takes the cost OpenRouter reports", async () => {
    provider = "openrouter";
    finishMetadata = { openrouter: { usage: { cost: 0.0123 } } };
    const seeded = await seed(100_000);
    expect(await send(seeded)).toBe(200);

    const [row] = await sql<{ cost_usd: string; cost_source: string; credits: string }[]>`
      SELECT * FROM agent_usage_records WHERE actor_user_id = ${seeded.userId}
    `;
    expect(row).toMatchObject({ cost_source: "provider" });
    expect(Number(row!.cost_usd)).toBeCloseTo(0.0123, 8);
    expect(Number(row!.credits)).toBeCloseTo(1.23, 6);
  }, 60_000);
});

describe("a chat turn needs a positive balance", () => {
  it("refuses the turn with 402 when the studio has nothing to spend", async () => {
    provider = "deepseek";
    finishMetadata = undefined;
    const seeded = await seed(0);
    expect(await send(seeded)).toBe(402);
    const rows = await sql`SELECT 1 FROM agent_usage_records WHERE actor_user_id = ${seeded.userId}`;
    expect(rows).toHaveLength(0);
  }, 60_000);
});
