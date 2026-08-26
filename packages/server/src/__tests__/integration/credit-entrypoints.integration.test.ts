// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 碰积分的那几个入口，全部走新引擎（任务 #11）。
 *
 * 换数据模型必须把写它的地方一次换完 —— 留一处写旧表，那一处的钱就从新账里
 * 消失。这个文件按入口逐个钉：充值到账、注册、鉴权中间件、预检、幂等扣费。
 *
 * 预检那三种情形是这里最要紧的一条。新模型下最高频的一条路径正好撞在它上面：
 * 用户刚买完一笔，它恒为未指定，他关掉面板直接去生成 —— 旧文案会告诉他
 * 「可用 0」，而他账上明明躺着刚付过钱的积分。
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// `ai` is stubbed: the real SDK is replaced with a double that reaches no
// network, so this suite needs no API key and the SDK stays out of its
// module graph.
// Fulfillment now asks Stripe what the session currently is, so this layer
// needs a double. Every fixture payment here is 1000 / usd, and the double
// answers with the same figures so the amount comparison holds.
const stripe = {
  checkout: {
    sessions: {
      retrieve: vi.fn(async (id: string) => ({
        id,
        mode: "payment",
        status: "complete",
        payment_status: "paid",
        amount_subtotal: 1000,
        amount_total: 1000,
        currency: "usd",
        total_details: { amount_tax: 0 },
        payment_intent: `pi_${id}`,
        consent: null,
        metadata: {},
      })),
    },
  },
};

vi.mock("@server/infra/stripe.js", () => ({
  getStripeClient: () => stripe,
}));

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
import * as paymentService from "@server/modules/payment/payment.service.js";
import * as authService from "@server/modules/auth/auth.service.js";
import { precheckCredits } from "@server/modules/payment/credit-precheck.service.js";

const PG_DRIVER_LOCAL = "credit-entrypoints-test-driver";

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
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: PG_DRIVER_LOCAL },
  });
  // 在 initCore 之后再 import：`@server/app.js` 会拉进 cors.ts，那个模块
  // 求值时就读 `env.ALLOWED_ORIGINS`。
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

/** 一个用户 + 他管理的 studio + 该 studio 下的一个 project。 */
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
 * One webhook event. The id and the type travel together because the claim
 * records both.
 * @param id - The event's own id.
 * @returns That event.
 */
function evt(id: string): { id: string; type: string } {
  return { id, type: "checkout.session.completed" };
}

/** 一笔待付款的结账会话。 */
async function seedPendingPayment(
  userId: string,
  credits: number,
): Promise<{ paymentId: string; sessionId: string }> {
  const sessionId = `cs_test_${seq++}_${Date.now()}`;
  const [payment] = await sql<{ id: string }[]>`
    INSERT INTO payments (user_id, stripe_session_id, amount_cents, status, credits_granted)
    VALUES (${userId}, ${sessionId}, 1000, 'pending', ${credits}) RETURNING id
  `;
  return { paymentId: payment!.id, sessionId };
}

describe("充值到账", () => {
  it("建出一笔 lot，不再写旧的余额表和流水表", async () => {
    const fx = await seedFixture();
    const { paymentId, sessionId } = await seedPendingPayment(fx.userId, 880);

    const outcome = await paymentService.fulfillPayment(sessionId, evt("evt_test_1"));
    expect(outcome.status).toBe("granted");

    const lots = await sql<{ id: string; remaining_credits: string }[]>`
      SELECT id, remaining_credits FROM credit_lots WHERE payment_id = ${paymentId}
    `;
    expect(lots).toHaveLength(1);
    expect(lots[0]?.remaining_credits).toBe("880.000000");

    // 归档表是上一个模型留下的只读记录，新的入账一行都不该落进去。
    const legacy = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM credit_transactions_archived WHERE user_id = ${fx.userId}
    `;
    expect(legacy[0]?.count).toBe("0");
  });

  it("同一个会话再送一次，只发一次积分", async () => {
    const fx = await seedFixture();
    const { paymentId, sessionId } = await seedPendingPayment(fx.userId, 880);

    await paymentService.fulfillPayment(sessionId, evt("evt_test_2"));
    const replay = await paymentService.fulfillPayment(sessionId, evt("evt_test_2"));

    expect(replay.status).toBe("replay");
    const counted = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM credit_lots WHERE payment_id = ${paymentId}
    `;
    expect(counted[0]?.count).toBe("1");
  });
});

describe("注册", () => {
  it("注册出来的账号一分积分都没有，也没有任何积分行", async () => {
    // 旧模型给每个新账号开一行余额。新模型里积分只从付款长出来，所以一个
    // 刚注册的账号在积分这边不该留下任何痕迹。
    const email = `reg-${seq++}-${Date.now()}@example.test`;
    const { user } = await authService.register(email, "correct horse battery");
    const counted = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM credit_lots WHERE user_id = ${user.id}
    `;
    expect(counted[0]?.count).toBe("0");
    expect(await creditLotService.getUnassignedCredits(user.id)).toBe(0);
  });
});

describe("预检", () => {
  it("这个 studio 有笔但不够时，说需要多少、可用多少", async () => {
    const fx = await seedFixture();
    const { sessionId } = await seedPendingPayment(fx.userId, 30);
    await paymentService.fulfillPayment(sessionId, evt(`evt_${seq++}`));
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

  it("这个 studio 一分没有而账号有未指定的，说的是没指定不是没钱", async () => {
    // 刚买完就去生成，是新模型下最高频的一条路径。把它说成「余额不足」
    // 会让用户以为付款没到账。
    const fx = await seedFixture();
    const { sessionId } = await seedPendingPayment(fx.userId, 880);
    await paymentService.fulfillPayment(sessionId, evt(`evt_${seq++}`));

    const err = await precheckCredits(fx.projectId, fx.userId, 100).then(
      () => null,
      (e: unknown) => e as { statusCode: number; message: string },
    );
    expect(err?.statusCode).toBe(402);
    expect(err?.message).toBe(t("server.credit.unassigned", { available: 880 }));
  });

  it("账号确实一分都没有时，说的是没钱", async () => {
    const fx = await seedFixture();
    const err = await precheckCredits(fx.projectId, fx.userId, 100).then(
      () => null,
      (e: unknown) => e as { statusCode: number; message: string },
    );
    expect(err?.statusCode).toBe(402);
    expect(err?.message).toBe(t("server.credit.none"));
  });

  it("欠着账时说清欠多少，即便账号里还有未指定的积分", async () => {
    // 这一条必须排在「你有未指定的积分，去指定吧」之前。欠账时可用额是负的，
    // 照旧的顺序会落到那句话上，而指定进来先抵债、抵完可能还是不能生成 ——
    // 等于把人支使去做一件解决不了问题的事。
    const fx = await seedFixture();
    const { sessionId } = await seedPendingPayment(fx.userId, 30);
    await paymentService.fulfillPayment(sessionId, evt(`evt_${seq++}`));
    await sql`UPDATE credit_lots SET designated_studio_id = ${fx.studioId} WHERE user_id = ${fx.userId}`;
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 350,
      referenceId: `pre-owe-${seq++}`,
    });
    // 账号里另有一笔没指定给任何 studio 的，旧顺序会先撞上它。
    const spare = await seedPendingPayment(fx.userId, 500);
    await paymentService.fulfillPayment(spare.sessionId, evt(`evt_${seq++}`));

    const err = await precheckCredits(fx.projectId, fx.userId, 100).then(
      () => null,
      (e: unknown) => e as { statusCode: number; message: string },
    );
    expect(err?.statusCode).toBe(402);
    expect(err?.message).toBe(t("server.credit.in_debt", { owed: 320 }));
  });

  it("够花就放行", async () => {
    const fx = await seedFixture();
    const { sessionId } = await seedPendingPayment(fx.userId, 880);
    await paymentService.fulfillPayment(sessionId, evt(`evt_${seq++}`));
    await sql`UPDATE credit_lots SET designated_studio_id = ${fx.studioId} WHERE user_id = ${fx.userId}`;

    await expect(precheckCredits(fx.projectId, fx.userId, 100)).resolves.toBeUndefined();
  });
});

describe("幂等扣费", () => {
  it("同一个 refKey 只扣一次", async () => {
    // 聊天一个回合和一次文本工具都可能被重放：断线重连、流重发。
    const fx = await seedFixture();
    const { sessionId } = await seedPendingPayment(fx.userId, 100);
    await paymentService.fulfillPayment(sessionId, evt(`evt_${seq++}`));
    await sql`UPDATE credit_lots SET designated_studio_id = ${fx.studioId} WHERE user_id = ${fx.userId}`;

    const refKey = `turn:${fx.projectId}:0`;
    const first = await creditLotService.chargeOnceForGeneration(refKey, {
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 10,
    });
    const second = await creditLotService.chargeOnceForGeneration(refKey, {
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 10,
    });

    expect(first?.charged).toBe(10);
    expect(second).toBeNull();

    const spendable = await creditLotService.getSpendableCredits(fx.studioId);
    expect(spendable).toBe(90);
  });
});

describe("会话载荷", () => {
  it("不再带账号总额", async () => {
    // 余额是派生的，而账号总额在「未指定不能花」之后不再是任何一个可花的
    // 数字。每个请求都下发它，只会有人拿它去做判断；要余额的地方去问
    // 分得清「能花的」和「未指定的」那个端点。
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
  it("形状不合法时当场答 422，不等到模型跑完才发现", async () => {
    // 这个 header 一路走到 `chargeOnceForGeneration` 的 refKey，而那里有
    // `REFKEY_PATTERN` 拦它。拦得太晚：到那一步模型已经调过了、token 已经
    // 烧掉了，而扣费抛出来的异常被 `recordTokenUsage` 的 catch 吞掉，用户
    // 拿到一个看着成功的响应。校验属于入口。
    const fx = await seedFixture();
    const token = crypto.randomBytes(24).toString("hex");
    await setSession(getRedis(), token, fx.userId);

    // 全都是真能发出去的：header 值限 latin-1，所以非 ASCII 的键在 HTTP
    // 层就被拒了，编一个进来只会测到 fetch 自己。
    for (const bad of ["a b", "a/b", "a,b", "x".repeat(256), ""]) {
      const res = await app.request("/api/v1/mini-tools/text", {
        method: "POST",
        headers: {
          Cookie: `${sessionCookieName()}=${token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": bad,
        },
        body: JSON.stringify({ tool: "generate", instructions: "写点什么" }),
      });
      expect(res.status, `Idempotency-Key = ${JSON.stringify(bad)}`).toBe(422);
    }
  });

  it("形状合法时照常放行", async () => {
    const fx = await seedFixture();
    const token = crypto.randomBytes(24).toString("hex");
    await setSession(getRedis(), token, fx.userId);

    const res = await app.request("/api/v1/mini-tools/text", {
      method: "POST",
      headers: {
        Cookie: `${sessionCookieName()}=${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "texttool.retry-1:abc_DEF",
      },
      body: JSON.stringify({ tool: "generate", instructions: "写点什么" }),
    });
    expect(res.status).toBe(200);
  });

  it("不给这个 header 也照常放行", async () => {
    // 缺省时服务端自己发一个 uuid，每次重试各算一次 —— 文本工具每次都重新
    // 生成内容，这是它本来的语义。
    const fx = await seedFixture();
    const token = crypto.randomBytes(24).toString("hex");
    await setSession(getRedis(), token, fx.userId);

    const res = await app.request("/api/v1/mini-tools/text", {
      method: "POST",
      headers: {
        Cookie: `${sessionCookieName()}=${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tool: "generate", instructions: "写点什么" }),
    });
    expect(res.status).toBe(200);
  });
});
