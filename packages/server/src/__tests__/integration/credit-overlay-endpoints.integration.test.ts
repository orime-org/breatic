// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 账号级积分覆盖层要的东西，端点今天给不全（任务 #12）。
 *
 * 覆盖层左侧七项的数据全部来自 #11 建的那四个端点。设计对抗两轮逐格对下来，
 * 有七处是端点供不上的 —— 这个套件把每一处钉成一条会红的断言，实现照着它做。
 *
 * 支付关闭那一处在另一个套件里，因为它要另一个 PAYMENT_ENABLED。
 */

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
import { creditLotService } from "@breatic/domain";

const PG_DRIVER_LOCAL = "credit-overlay-test-driver";

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
  studioName: string;
  studioSlug: string;
  projectId: string;
  cookie: string;
}

/**
 * 一个登录用户 + 他管理的一个 team studio + 该 studio 下的一个 project。
 * @returns 这一组的 id 与登录 cookie。
 */
async function seedFixture(): Promise<Fixture> {
  const n = seq++;
  const stamp = Date.now();
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`overlay-${n}-${stamp}@example.test`}, true) RETURNING id
  `;
  const userId = user!.id;
  const studioSlug = `overlay-s-${n}-${stamp}`;
  const studioName = `覆盖层队 ${n}`;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${studioSlug}, 'team', ${studioName}) RETURNING id
  `;
  const studioId = studio!.id;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studioId}, ${userId}, 'admin')
  `;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, slug, name)
    VALUES (${studioId}, ${userId}, ${`overlay-p-${n}-${stamp}`}, ${`覆盖层项目 ${n}`})
    RETURNING id
  `;
  await sql`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`overlay-me-${n}-${stamp}`}, 'personal', ${`覆盖层本人 ${n}`})
  `;
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return {
    userId,
    studioId,
    studioName,
    studioSlug,
    projectId: project!.id,
    cookie: `${sessionCookieName()}=${token}`,
  };
}

/**
 * 一笔到账的积分。
 * @param userId - 买它的账号。
 * @param credits - 买到多少积分。
 * @param amountCents - 实付多少分，默认 1000。
 * @param designateTo - 指定给哪个 studio，默认不指定。
 * @returns 这个积分包的 id。
 */
async function seedLot(
  userId: string,
  credits: number,
  amountCents = 1000,
  designateTo: string | null = null,
): Promise<string> {
  const [payment] = await sql<{ id: string }[]>`
    INSERT INTO payments (user_id, amount_cents, status, credits_granted)
    VALUES (${userId}, ${amountCents}, 'completed', ${credits}) RETURNING id
  `;
  const lot = await creditLotService.grantFromPayment({
    paymentId: payment!.id,
    userId,
    purchasedCredits: credits,
  });
  if (designateTo !== null) {
    await sql`UPDATE credit_lots SET designated_studio_id = ${designateTo} WHERE id = ${lot.id}`;
  }
  return lot.id;
}

/**
 * 读一次总览。
 * @param cookie - 登录 cookie。
 * @returns 端点返回的 data。
 */
async function readOverview(cookie: string): Promise<Record<string, unknown>> {
  const res = await app.request("/api/v1/credits/overview", { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  return body.data;
}

/**
 * 读一页积分包。
 * @param cookie - 登录 cookie。
 * @param query - 附加的查询串，例如 `&lifecycle=active`。
 * @returns 端点返回的一页。
 */
async function readLots(
  cookie: string,
  query = "",
): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }> {
  const res = await app.request(`/api/v1/credits/lots?limit=50${query}`, {
    headers: { cookie },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: { items: Record<string, unknown>[]; nextCursor: string | null };
  };
  return body.data;
}

describe("总览要能说出每个 studio 是谁（计划 §4.1）", () => {
  it("每个 studio 带名字和 slug", async () => {
    const fx = await seedFixture();
    await seedLot(fx.userId, 500, 1000, fx.studioId);

    const data = await readOverview(fx.cookie);
    const studios = data['studios'] as Record<string, unknown>[];
    const mine = studios.find((s) => s['studioId'] === fx.studioId);

    expect(mine).toBeDefined();
    // 前端手上只有 uuid。GET /studios/ 只返回「我还是活跃成员」的那些，
    // 而这里报的 studio 不受成员关系约束（被踢出去了照样报），拿那份列表
    // 补名字会补不上——所以名字得从这里出。
    expect(mine!['studioName']).toBe(fx.studioName);
    expect(mine!['studioSlug']).toBe(fx.studioSlug);
  });
});

describe("已删的 studio 花掉的钱留在账上（计划 §4.2）", () => {
  it("那一行仍然出现，名字取得到，可用额是零", async () => {
    const fx = await seedFixture();
    await seedLot(fx.userId, 500, 1000, fx.studioId);
    // 在它还活着的时候花掉一部分。
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 120,
      model: "seedream-4.0",
      provider: "volcengine",
    });
    await sql`UPDATE studios SET deleted_at = now() WHERE id = ${fx.studioId}`;

    const data = await readOverview(fx.cookie);
    const studios = data['studios'] as Record<string, unknown>[];
    const gone = studios.find((s) => s['studioId'] === fx.studioId);

    // AWS 和 Google Cloud 对已终止的资源都保留历史成本：那段时间的钱真的
    // 花了。转让同理——payer_user_id 不随 studio 易主而变。
    expect(gone).toBeDefined();
    expect(gone!['studioName']).toBe(fx.studioName);
    expect(Number(gone!['spent'])).toBe(120);
    // 钱花不出去了，可用额那一半仍然排除已删 studio。
    expect(Number(gone!['spendable'])).toBe(0);
  });
});

describe("「已删除」要读得出来，不是从别处猜的（实现对抗第一轮）", () => {
  it("包用完了的 studio 还活着，不许标成已删除", async () => {
    const fx = await seedFixture();
    await seedLot(fx.userId, 100, 1000, fx.studioId);
    // 把这个包扣到恰好零：planCharge 取 min(remaining, owed)，所以
    // applyCharge 的 CASE 会把它置成 depleted。这是每个包的终局。
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 100,
      referenceId: `deplete-${Date.now()}`,
      model: "seedream-4.0",
      provider: "volcengine",
    });

    const data = await readOverview(fx.cookie);
    const studios = data['studios'] as Record<string, unknown>[];
    const mine = studios.find((s) => s['studioId'] === fx.studioId);

    expect(mine).toBeDefined();
    // 它一个 active 包都没有了，但它还在。前端拿这个字段画「已删除」徽章、
    // 把可用额换成破折号、把筛选下拉里的名字换掉。
    expect(mine!['deleted']).toBe(false);
    expect(mine!['studioName']).toBe(fx.studioName);
    expect(Number(mine!['spent'])).toBe(100);
  });

  it("包改指给别的 studio 之后，原来那个还活着", async () => {
    const fx = await seedFixture();
    const lotId = await seedLot(fx.userId, 300, 1000, fx.studioId);
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 50,
      referenceId: `before-move-${Date.now()}`,
      model: "seedream-4.0",
      provider: "volcengine",
    });
    // 验收项 10 要求的那一步：改指定，原 studio 立即失去这个包。
    await sql`UPDATE credit_lots SET designated_studio_id = NULL WHERE id = ${lotId}`;

    const data = await readOverview(fx.cookie);
    const studios = data['studios'] as Record<string, unknown>[];
    const mine = studios.find((s) => s['studioId'] === fx.studioId);

    expect(mine!['deleted']).toBe(false);
    expect(Number(mine!['spent'])).toBe(50);
  });
});

describe("消耗流水只列消耗（实现对抗第一轮）", () => {
  it("指定积分抵掉欠账，不出现在消耗流水里", async () => {
    const fx = await seedFixture();
    // 先欠上：没有包可扣，整笔记成欠账。
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 40,
      referenceId: `owe-${Date.now()}`,
      model: "seedream-4.0",
      provider: "volcengine",
    });
    const lotId = await seedLot(fx.userId, 500, 1000, null);
    // 指过去，它会先抵欠账，写一行 debt_repayment。
    await creditLotService.designateLot({
      lotId,
      requestingUserId: fx.userId,
      studioId: fx.studioId,
    });

    const res = await app.request("/api/v1/credits/ledger?limit=50", {
      headers: { cookie: fx.cookie },
    });
    const body = (await res.json()) as {
      data: { items: Record<string, unknown>[] };
    };

    // 它没有 model、没有 project，六列里三列是空的；混进来读起来是一次
    // 凭空的生成。验收项 7：只列消耗，不混欠账记账。
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]!['model']).toBe("seedream-4.0");
  });
});

describe("总览要能说出欠了多少、指了几个包（计划 §4.3）", () => {
  it("每个 studio 带欠账和已指定积分包数", async () => {
    const fx = await seedFixture();
    await seedLot(fx.userId, 300, 1000, fx.studioId);
    await seedLot(fx.userId, 200, 1000, fx.studioId);

    const data = await readOverview(fx.cookie);
    const studios = data['studios'] as Record<string, unknown>[];
    const mine = studios.find((s) => s['studioId'] === fx.studioId);

    expect(mine).toBeDefined();
    expect(Number(mine!['debt'])).toBe(0);
    // 只要数量，不要列表：用户要知道的是「有没有指定」。
    expect(Number(mine!['lotCount'])).toBe(2);
  });

  it("指向已软删 studio 的包不算进任何一组", async () => {
    const fx = await seedFixture();
    await seedLot(fx.userId, 400, 1000, fx.studioId);
    await sql`UPDATE studios SET deleted_at = now() WHERE id = ${fx.studioId}`;

    const data = await readOverview(fx.cookie);
    const studios = data['studios'] as Record<string, unknown>[];
    const gone = studios.find((s) => s['studioId'] === fx.studioId);

    // 这个包已经按 sumUnassignedForUser 算进了「未指定」（orphaned 读侧当
    // unassigned）。再算进一个分组，同一个包就出现两次。
    //
    // 这一条今天就是绿的：#11 的 or(isNull(designated_studio_id),
    // isNotNull(studios.deleted_at)) 已经把它算对了。留着是护栏——§4.3 要新
    // 加一个按 studio 分组的 count，那个 count 不判 studio 存活就会破掉它。
    expect(Number(data['unassignedCredits'])).toBe(400);
    expect(gone).toBeUndefined();
  });
});

describe("总览要说清这个部署计不计积分（计划 §4.4）", () => {
  it("带一个标志，让空账和不计费分得开", async () => {
    const fx = await seedFixture();

    const data = await readOverview(fx.cookie);

    // 三个数为零 + studios 为空，在 wire 上跟「这个部署不计积分」一模一样。
    // PAYMENT_ENABLED 只有服务端读得到，所以得由它说出来。
    expect(data['billing']).toBe(true);
  });
});

describe("充值记录要显示实付和指定去向（计划 §4.5 §4.6）", () => {
  it("每个积分包带实付金额与币种", async () => {
    const fx = await seedFixture();
    await seedLot(fx.userId, 880, 1000);

    const page = await readLots(fx.cookie);
    const lot = page.items[0];

    expect(lot).toBeDefined();
    // 实付在 payments 上，不在 credit_lots 上。拿积分数反查包价表也不行：
    // 那张表会整份换掉（#13），历史积分包的实付是买它那天的价。
    expect(Number(lot!['paidCents'])).toBe(1000);
    expect(lot!['currency']).toBe("usd");
  });

  it("指定去向带 studio 名字", async () => {
    const fx = await seedFixture();
    await seedLot(fx.userId, 500, 1000, fx.studioId);

    const page = await readLots(fx.cookie);
    const lot = page.items[0];

    expect(lot).toBeDefined();
    expect(lot!['designatedStudioId']).toBe(fx.studioId);
    expect(lot!['designatedStudioName']).toBe(fx.studioName);
  });
});

describe("三项各要自己那个子集（计划 §4.7）", () => {
  it("lots 接受 lifecycle 入参", async () => {
    const fx = await seedFixture();
    const active = await seedLot(fx.userId, 500, 1000, fx.studioId);
    const depleted = await seedLot(fx.userId, 100, 1000, fx.studioId);
    await sql`
      UPDATE credit_lots SET lifecycle = 'depleted', remaining_credits = 0
      WHERE id = ${depleted}
    `;

    const page = await readLots(fx.cookie, "&lifecycle=active");
    const ids = page.items.map((l) => l['id']);

    // 「指定」只列 active、「退款」按状态分三桶、「充值记录」要全部。
    // 前端在 keyset 流上滤，会让「滚到底加载下一页」的判据失效——滤完一页
    // 可能一行不剩而 nextCursor 还在。
    expect(ids).toContain(active);
    expect(ids).not.toContain(depleted);
  });
});

describe("一次生成在流水里是一行（计划 §4.8）", () => {
  it("跨多个积分包的一次生成合成一行，合计等于总消耗", async () => {
    const fx = await seedFixture();
    // 三个小包，一次生成要跨完它们。
    await seedLot(fx.userId, 100, 1000, fx.studioId);
    await seedLot(fx.userId, 100, 1000, fx.studioId);
    await seedLot(fx.userId, 100, 1000, fx.studioId);
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 250,
      // Every real charge carries one: the canvas path passes the task id
      // (`dispatch.ts:807`) and the agent and text tools go through
      // `chargeOnceForGeneration`, which passes its idempotency key. It is
      // what ties the rows of one generation together.
      referenceId: `overlay-charge-${Date.now()}`,
      model: "kling-v2.1",
      provider: "kuaishou",
    });

    const res = await app.request("/api/v1/credits/ledger?limit=50", {
      headers: { cookie: fx.cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { items: Record<string, unknown>[] };
    };
    const rows = body.data.items;

    // 一次生成对每个取到的包写一行 spend，全在同一瞬间。逐行返回的话，
    // 分页边界会落在一次生成中间，把它显示成两次、每次只带总数的一片。
    // listLedgerByStudio 已经把这件事定性为 bug 并按 reference_id 分组解决过。
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!['consumed'])).toBe(-250);
  });

  it("充值那一行不出现在消耗流水里", async () => {
    const fx = await seedFixture();
    await seedLot(fx.userId, 500, 1000, fx.studioId);

    const res = await app.request("/api/v1/credits/ledger?limit=50", {
      headers: { cookie: fx.cookie },
    });
    const body = (await res.json()) as {
      data: { items: Record<string, unknown>[] };
    };

    // topup 的 payer_user_id 也是登录者本人，而它没有 actor / project / model，
    // 六列里四列是空的。
    expect(body.data.items).toHaveLength(0);
  });
});
