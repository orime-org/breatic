// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every entry point that touches credits goes through the lot engine (task #11).
 *
 * Changing the data model means changing every place that writes it at once:
 * one place left writing the old tables is money that disappears from the new
 * books. This file pins each entry point: a payment grant, registration, the
 * session payload, the precheck and the idempotent charge.
 *
 * The precheck's three cases matter most. The most frequent path under the
 * new model runs straight into it: a user who has just bought a pack holds
 * credits designated to no Studio, closes the panel and goes to generate —
 * the old copy would tell them "0 available" while the credits they just paid
 * for sit on their account.
 */

import { initConfiguredProvider } from "@breatic/integration-tests/provider";
import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// `ai` is stubbed: the real SDK is replaced with a double that reaches no
// network, so this suite needs no API key and the SDK stays out of its
// module graph.
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

import crypto from "node:crypto";
import type { Hono } from "hono";
import postgres from "postgres";
import {
  initCore,
  loadLocales,
  getRedis,
  setSession,
  sessionCookieName,
} from "@breatic/core";
import { t } from "@breatic/shared";
import { creditLotService } from "@breatic/domain";
import * as authService from "@server/modules/auth/auth.service.js";
import { grantPayment } from "@server/modules/commerce/payment-grant.service.js";
import { precheckCredits } from "@server/modules/credit/credit-precheck.service.js";
import { openPaymentSource, recordPaymentReceipt } from "./payment-source.js";
import { chargeNow } from "./studio-credit-fixtures.js";

const PG_DRIVER_LOCAL = "credit-entrypoints-test-driver";

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  initCore({ ...process.env, CHARGING_ENABLED: "true" });
  loadLocales();
  initConfiguredProvider();
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: PG_DRIVER_LOCAL },
  });
  // Imported after initCore: `@server/app.js` pulls in cors.ts, which reads
  // `env.ALLOWED_ORIGINS` when the module is evaluated.
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  initCore(process.env);
});

let seq = 0;

interface Fixture {
  userId: string;
  studioId: string;
  projectId: string;
}

/**
 * A user, a Studio they administer and a project in it.
 * @returns The fixture.
 */
async function seedFixture(): Promise<Fixture> {
  const n = seq++;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`entry-${n}-${Date.now()}@example.test`}, true) RETURNING id
  `;
  const userId = user!.id;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`entry-s-${n}-${Date.now()}`}, 'team', 'Entry') RETURNING id
  `;
  const studioId = studio!.id;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studioId}, ${userId}, 'admin')
  `;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, slug, name)
    VALUES (${studioId}, ${userId}, ${`entry-p-${n}-${Date.now()}`}, 'Entry') RETURNING id
  `;
  return { userId, studioId, projectId: project!.id };
}

/**
 * Credits from a completed payment, granted the way the billing service's
 * grant leaves them: a receipt and its lot, designated to no Studio.
 * @param userId - The buyer.
 * @param credits - What the payment bought.
 * @returns The payment's id.
 */
async function fundFromPayment(userId: string, credits: number): Promise<string> {
  const paymentId = await openPaymentSource(sql);
  await recordPaymentReceipt(sql, { id: paymentId, userId, amountCents: 1000, credits });
  await creditLotService.grantFromPayment({ paymentId, userId, purchasedCredits: credits });
  return paymentId;
}

describe("payment grant", () => {
  it("opens one lot and writes nothing to the archived balance tables", async () => {
    const fx = await seedFixture();
    const paymentId = crypto.randomUUID();

    const answer = await grantPayment(paymentId, {
      userId: fx.userId,
      purchasedCredits: 880,
      amountCents: 1000,
      taxCents: null,
      totalCents: null,
      currency: "usd",
      orderedAt: new Date().toISOString(),
      conversion: { consent: { analytics: false, ads: false }, click: null, transactionId: `purchase:${paymentId}` },
    });
    expect(answer.httpStatus).toBe(200);

    const lots = await sql<{ id: string; remaining_credits: string }[]>`
      SELECT id, remaining_credits FROM credit_lots WHERE source_id = ${paymentId}
    `;
    expect(lots).toHaveLength(1);
    expect(lots[0]?.remaining_credits).toBe("880.000000");

    // The archive is the previous model's read-only record; no new grant lands in it.
    const legacy = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM credit_transactions_archived WHERE user_id = ${fx.userId}
    `;
    expect(legacy[0]?.count).toBe("0");
  });
});

describe("registration", () => {
  it("leaves the new account with no credits and no credit rows", async () => {
    // Registration creates no personal Studio yet; its setup grants trial credits.
    const email = `reg-${seq++}-${Date.now()}@example.test`;
    const { user } = await authService.register(email, "correct horse battery");
    const counted = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM credit_lots WHERE user_id = ${user.id}
    `;
    expect(counted[0]?.count).toBe("0");
    expect(await creditLotService.getUnassignedCredits(user.id)).toBe("0.000000");
  });
});

describe("precheck", () => {
  it("says how much is needed and how much is available when the Studio has some but not enough", async () => {
    const fx = await seedFixture();
    await fundFromPayment(fx.userId, 30);
    await sql`UPDATE credit_lots SET designated_studio_id = ${fx.studioId} WHERE user_id = ${fx.userId}`;

    const err = await precheckCredits(fx.projectId, fx.userId, 100).then(
      () => null,
      (e: unknown) => e as { statusCode: number; message: string },
    );
    expect(err?.statusCode).toBe(402);
    expect(err?.message).toBe(
      t("server.error.insufficient_credits", { required: 100, available: 30 }),
    );
  });

  it("says the credits are undesignated, not missing, when the Studio has none but the account does", async () => {
    // Generating right after buying is the most frequent path under the new
    // model. Calling it "insufficient balance" would make the user think the
    // payment never arrived.
    const fx = await seedFixture();
    await fundFromPayment(fx.userId, 880);

    const err = await precheckCredits(fx.projectId, fx.userId, 100).then(
      () => null,
      (e: unknown) => e as { statusCode: number; message: string },
    );
    expect(err?.statusCode).toBe(402);
    expect(err?.message).toBe(t("server.credit.unassigned", { available: 880 }));
  });

  it("says there are no credits when the account truly has none", async () => {
    const fx = await seedFixture();
    const err = await precheckCredits(fx.projectId, fx.userId, 100).then(
      () => null,
      (e: unknown) => e as { statusCode: number; message: string },
    );
    expect(err?.statusCode).toBe(402);
    expect(err?.message).toBe(t("server.credit.none"));
  });

  it("says how much is owed while in debt, even when the account holds undesignated credits", async () => {
    // This must come before "you have undesignated credits, designate them".
    // In debt the available amount is negative and the old order would land
    // on that sentence, yet designated credits pay the debt first and may
    // still not allow a generation — sending the user to do something that
    // does not solve their problem.
    const fx = await seedFixture();
    await fundFromPayment(fx.userId, 30);
    await sql`UPDATE credit_lots SET designated_studio_id = ${fx.studioId} WHERE user_id = ${fx.userId}`;
    await chargeNow({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 350,
      referenceId: `pre-owe-${seq++}`,
    });
    // Another lot designated to no Studio, which the old order would hit first.
    await fundFromPayment(fx.userId, 500);

    const err = await precheckCredits(fx.projectId, fx.userId, 100).then(
      () => null,
      (e: unknown) => e as { statusCode: number; message: string },
    );
    expect(err?.statusCode).toBe(402);
    expect(err?.message).toBe(t("server.credit.in_debt", { owed: 320 }));
  });

  it("lets the request through when there is enough", async () => {
    const fx = await seedFixture();
    await fundFromPayment(fx.userId, 880);
    await sql`UPDATE credit_lots SET designated_studio_id = ${fx.studioId} WHERE user_id = ${fx.userId}`;

    await expect(precheckCredits(fx.projectId, fx.userId, 100)).resolves.toBeUndefined();
  });
});

describe("idempotent charge", () => {
  it("charges one refKey only once", async () => {
    // A chat turn and a text tool run can both be replayed: a reconnect, a resent stream.
    const fx = await seedFixture();
    await fundFromPayment(fx.userId, 100);
    await sql`UPDATE credit_lots SET designated_studio_id = ${fx.studioId} WHERE user_id = ${fx.userId}`;

    const refKey = `turn:${fx.projectId}:0`;
    const first = await creditLotService.chargeOnce("operation", refKey, {
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 10,
    });
    const second = await creditLotService.chargeOnce("operation", refKey, {
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 10,
    });

    expect(first?.charged).toBe("10.000000");
    expect(second).toBeNull();

    const spendable = await creditLotService.getSpendableCredits(fx.studioId);
    expect(spendable).toBe("90.000000");
  });
});

describe("session payload", () => {
  it("no longer carries the account total", async () => {
    // Balances are derived, and since undesignated credits cannot be spent the
    // account total is no longer any spendable number. Sending it on every
    // request only invites decisions based on it; whoever needs a balance asks
    // the endpoint that tells spendable from undesignated.
    const fx = await seedFixture();
    const token = crypto.randomBytes(24).toString("hex");
    await setSession(getRedis(), token, fx.userId);

    const res = await app.request("/api/v1/auth/me", {
      headers: { Cookie: `${sessionCookieName()}=${token}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(Object.keys(body.data)).not.toContain("credits");
  });
});

describe("Idempotency-Key", () => {
  /**
   * A project the caller edits, in a studio that can pay: the text tool now
   * takes a project, checks the caller's role on it and prechecks its credits
   * before it reads anything else (inner#1860).
   * @returns The fixture.
   */
  async function seedFundedEditor(): Promise<Fixture> {
    const fx = await seedFixture();
    await sql`
      INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${fx.projectId}, ${fx.userId}, 'owner', null)
    `;
    await fundFromPayment(fx.userId, 100);
    await sql`UPDATE credit_lots SET designated_studio_id = ${fx.studioId} WHERE user_id = ${fx.userId}`;
    return fx;
  }

  it("ignores the Idempotency-Key header: the charge key is minted by the server", async () => {
    // The text tool records and charges every run under a key the route mints
    // per request (inner#1860), so whatever the client sends in this header —
    // nothing, a well-formed key, or one REFKEY_PATTERN would refuse — never
    // reaches the charge and changes nothing about the request.
    const fx = await seedFundedEditor();
    const token = crypto.randomBytes(24).toString("hex");
    await setSession(getRedis(), token, fx.userId);

    for (const header of [undefined, "texttool.retry-1:abc_DEF", "a b", "a/b", "x".repeat(256), ""]) {
      const res = await app.request("/api/v1/mini-tools/text", {
        method: "POST",
        headers: {
          Cookie: `${sessionCookieName()}=${token}`,
          "Content-Type": "application/json",
          ...(header === undefined ? {} : { "Idempotency-Key": header }),
        },
        body: JSON.stringify({ tool: "generate", instructions: "write something", project_id: fx.projectId }),
      });
      expect(res.status, `Idempotency-Key = ${JSON.stringify(header)}`).toBe(200);
    }
  });
});
