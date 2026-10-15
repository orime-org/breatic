// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Each run-once entry does its work once for a press sent twice (inner#1490)
 * — real PG and Redis, through the real Hono app.
 *
 * The browser re-sends an unanswered press with the same `Idempotency-Key`.
 * For every entry below, the second arrival must come back as the first
 * answer replayed, and whatever the press writes or sends must have happened
 * exactly once. Generate and new-conversation carry the same pin in their own
 * suites (`storage-quota-routes`, `conversation-naming`).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, inject, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

const stripe = {
  customers: { create: vi.fn() },
  checkout: { sessions: { create: vi.fn(), retrieve: vi.fn() } },
  subscriptions: { update: vi.fn(), retrieve: vi.fn() },
};

vi.mock("@server/infra/stripe.js", () => ({
  getStripeClient: () => stripe,
}));

vi.mock("@server/utils/send-best-effort-mail.js", () => ({
  sendBestEffortMail: async () => {},
}));

import crypto from "node:crypto";
import postgres from "postgres";
import {
  initCore,
  getRedis,
  setSession,
  sessionCookieName,
  loadLocales,
  getSubscriptionPlan,
} from "@breatic/core";
import type { Hono } from "hono";
import { getPricingTiers } from "@server/config/pricing.js";
import { confirmCheckout } from "@server/modules/subscription/subscription.service.js";

/**
 * The suite's environment. The upscaler's provider needs a key to be served,
 * or the mini-tool press is refused with 503 before any row opens; no worker
 * runs here, so the queued job never reaches it.
 */
const SUITE_ENV = { ...process.env, WAVESPEED_API_KEY: "wavespeed-key-for-this-suite" };

let sql: ReturnType<typeof postgres>;
let app: Hono;
let seq = 0;

beforeAll(async () => {
  initCore(SUITE_ENV);
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "run-once-entries-test" },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  initCore(process.env);
});

/** A signed-in account. */
interface Account {
  userId: string;
  studioId: string;
  projectId: string;
  cookie: string;
}

/**
 * An account with a personal studio and a project it owns, signed in.
 * @param customerId - The Stripe customer to record on the account, if any.
 * @returns The ids and a login cookie.
 */
async function seedAccount(customerId: string | null = null): Promise<Account> {
  seq += 1;
  const stamp = `${Date.now()}-${seq}`;
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, stripe_customer_id)
    VALUES (${`roe-${stamp}@example.test`}, true, ${customerId})
    RETURNING id
  `;
  const userId = u!.id;
  const [st] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`roe-p-${stamp}`}, 'personal', 'Personal')
    RETURNING id
  `;
  const studioId = st!.id;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studioId}, ${userId}, 'admin')
  `;
  const slug = `roe-proj-${seq}`;
  const [p] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studioId}, ${userId}, ${`P ${slug}`}, ${slug})
    RETURNING id
  `;
  const projectId = p!.id;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${projectId}, ${userId}, 'owner', null)
  `;
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return { userId, studioId, projectId, cookie: `${sessionCookieName()}=${token}` };
}

/**
 * Send the same press twice, as the browser re-sends an unanswered one.
 * @param path - The entry.
 * @param cookie - The caller's session cookie.
 * @param body - The request body.
 * @returns Both answers, in order.
 */
async function pressTwice(
  path: string,
  cookie: string,
  body: Record<string, unknown>,
): Promise<{ first: Response; again: Response }> {
  const press = {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(body),
  };
  const first = await app.request(path, press);
  const again = await app.request(path, press);
  return { first, again };
}

/**
 * Assert the second answer is the first one replayed.
 * @param first - The first answer.
 * @param again - The answer to the re-sent press.
 * @param status - The status the first answer must carry.
 * @returns Nothing.
 */
async function expectReplayed(first: Response, again: Response, status: number): Promise<void> {
  expect(first.status).toBe(status);
  expect(again.status).toBe(status);
  expect(first.headers.get("Idempotent-Replayed")).toBeNull();
  expect(again.headers.get("Idempotent-Replayed")).toBe("true");
  expect(await again.json()).toEqual(await first.json());
}

/**
 * How many task rows a project holds, and how many node rows a node holds.
 * @param projectId - The project.
 * @param nodeId - The node the run writes to.
 * @returns Both counts.
 */
async function taskCounts(projectId: string, nodeId: string): Promise<{ tasks: number; nodeTasks: number }> {
  const [tasks] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM tasks WHERE project_id = ${projectId}
  `;
  const [nodeTasks] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM node_tasks WHERE node_id = ${nodeId}
  `;
  return { tasks: tasks!.n, nodeTasks: nodeTasks!.n };
}

describe("canvas and project entries", () => {
  it("starts one reading for an understand press sent twice", async () => {
    const { cookie, projectId } = await seedAccount();
    const nodeId = crypto.randomUUID();

    const { first, again } = await pressTwice("/api/v1/canvas/understand", cookie, {
      project_id: projectId,
      space_id: crypto.randomUUID(),
      source_type: "image",
      source_url: "https://assets.invalid/image/a.png",
      node_ids: [nodeId],
    });

    await expectReplayed(first, again, 201);
    expect(await taskCounts(projectId, nodeId)).toEqual({ tasks: 1, nodeTasks: 1 });
  });

  it("starts one mini-tool run for a press sent twice", async () => {
    const { cookie, projectId } = await seedAccount();
    const nodeId = crypto.randomUUID();

    const { first, again } = await pressTwice("/api/v1/mini-tools", cookie, {
      tool: "image.upscale",
      project_id: projectId,
      space_id: crypto.randomUUID(),
      node_ids: [nodeId],
      source: { url: "https://assets.invalid/image/a.png" },
      params: { target_megapixels: 16, creativity: 2 },
      slots: {},
    });

    await expectReplayed(first, again, 201);
    expect(await taskCounts(projectId, nodeId)).toEqual({ tasks: 1, nodeTasks: 1 });
  });

  it("creates one project for a press sent twice", async () => {
    const { cookie, studioId } = await seedAccount();
    seq += 1;

    const { first, again } = await pressTwice("/api/v1/projects", cookie, {
      studioId,
      name: "Twice pressed",
      slug: `roe-new-${Date.now()}-${seq}`,
    });

    await expectReplayed(first, again, 201);
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM projects WHERE studio_id = ${studioId}
    `;
    // The seeded project plus the one this press made.
    expect(row!.n).toBe(2);
  });
});

describe("payment entries", () => {
  beforeAll(() => {
    initCore({
      ...SUITE_ENV,
      PAYMENT_ENABLED: "true",
      STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
      STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
    });
  });

  afterAll(() => {
    initCore(SUITE_ENV);
  });

  const PERIOD_END = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;

  /**
   * A subscription as Stripe describes it, on one tier's monthly price.
   * @param id - The subscription id.
   * @param userId - Whose it is.
   * @param customerId - The Stripe customer.
   * @param tier - Which tier its price sells.
   * @returns A subscription object.
   */
  function subscriptionOn(
    id: string,
    userId: string,
    customerId: string,
    tier: "pro" | "team",
  ): Record<string, unknown> {
    const plan = getSubscriptionPlan(tier, "month");
    return {
      id,
      customer: customerId,
      status: "active",
      cancel_at_period_end: false,
      pending_update: null,
      latest_invoice: null,
      items: {
        data: [
          {
            id: "si_1",
            current_period_end: PERIOD_END,
            price: {
              id: plan.stripePriceId,
              unit_amount: plan.priceCents,
              currency: plan.currency,
              recurring: { interval: "month" },
            },
          },
        ],
      },
      metadata: { userId },
    };
  }

  it("opens one membership checkout for a press sent twice", async () => {
    const { cookie } = await seedAccount(`cus_roe_${Date.now()}_${seq}`);
    stripe.checkout.sessions.create.mockResolvedValue({
      id: "cs_roe_membership",
      url: "https://checkout.stripe.com/c/pay/cs_roe_membership",
    });

    const { first, again } = await pressTwice("/api/v1/account/subscription/checkout", cookie, {
      tier: "pro",
      period: "month",
      return_url: "https://app.example.test/back",
    });

    await expectReplayed(first, again, 200);
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
  });

  it("changes the membership once for a press sent twice", async () => {
    const customerId = `cus_roe_${Date.now()}_${seq}`;
    const { userId, cookie } = await seedAccount(customerId);
    const subscriptionId = `sub_roe_${Date.now()}_${seq}`;
    // A live PRO subscription, stored through the same path a checkout return takes.
    stripe.checkout.sessions.retrieve.mockResolvedValueOnce({
      id: `cs_roe_${seq}`,
      mode: "subscription",
      client_reference_id: userId,
      subscription: subscriptionOn(subscriptionId, userId, customerId, "pro"),
    });
    await confirmCheckout(userId, `cs_roe_${seq}`);
    stripe.subscriptions.update.mockResolvedValue(
      subscriptionOn(subscriptionId, userId, customerId, "team"),
    );

    const { first, again } = await pressTwice("/api/v1/account/subscription/change", cookie, {
      tier: "team",
      period: "month",
    });

    await expectReplayed(first, again, 200);
    expect(stripe.subscriptions.update).toHaveBeenCalledTimes(1);
  });

  it("opens one credits checkout for a press sent twice", async () => {
    const { userId, cookie } = await seedAccount();
    stripe.checkout.sessions.create.mockResolvedValue({
      id: `cs_roe_credits_${Date.now()}_${seq}`,
      url: "https://checkout.stripe.com/c/pay/cs_roe_credits",
    });

    const { first, again } = await pressTwice("/api/v1/payment/checkout", cookie, {
      price_cents: getPricingTiers()[0]!.priceCents,
      return_url: "https://app.example.test/s/mine",
      time_zone: "Asia/Shanghai",
      consented: true,
    });

    await expectReplayed(first, again, 201);
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM payments WHERE user_id = ${userId}
    `;
    expect(row!.n).toBe(1);
  });
});
