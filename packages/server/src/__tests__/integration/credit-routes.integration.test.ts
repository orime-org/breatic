// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 积分的五个端点（任务 #11）。
 *
 * 四个读一个写。读的那四个是覆盖层和 studio 积分页的全部数据源，写的那个是
 * 「指定」这一步 —— 而在「未指定不能花」之后，指定是钱能不能用的开关。
 *
 * 这里只走 HTTP：形状、状态码、谁看得见什么。引擎自己的账在 credit-engine
 * 那个套件里钉。
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

const PG_DRIVER_LOCAL = "credit-routes-test-driver";

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
  studioSlug: string;
  projectId: string;
  projectName: string;
  personalStudioName: string;
  cookie: string;
}

/** 一个登录用户 + 他管理的 studio + 该 studio 下的一个 project。 */
async function seedFixture(): Promise<Fixture> {
  const n = seq++;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`route-${n}-${Date.now()}@example.test`}, true) RETURNING id
  `;
  const userId = user!.id;
  const studioSlug = `route-s-${n}-${Date.now()}`;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${studioSlug}, 'team', 'Route') RETURNING id
  `;
  const studioId = studio!.id;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studioId}, ${userId}, 'admin')
  `;
  const projectName = `Route 项目 ${n}`;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, slug, name)
    VALUES (${studioId}, ${userId}, ${`route-p-${n}-${Date.now()}`}, ${projectName}) RETURNING id
  `;
  // 显示名住在个人 studio 上（users 是纯鉴权表），跟活动流取名字同一处。
  const personalStudioName = `Route 本人 ${n}`;
  await sql`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`route-me-${n}-${Date.now()}`}, 'personal', ${personalStudioName})
  `;
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return {
    userId,
    studioId,
    studioSlug,
    projectId: project!.id,
    projectName,
    personalStudioName,
    cookie: `${sessionCookieName()}=${token}`,
  };
}

/** 一笔到账的积分，可选指定去向。 */
async function seedLot(
  fx: Pick<Fixture, "userId">,
  credits: number,
  designateTo: string | null = null,
): Promise<string> {
  const [payment] = await sql<{ id: string }[]>`
    INSERT INTO payments (user_id, amount_cents, status, credits_granted)
    VALUES (${fx.userId}, 1000, 'completed', ${credits}) RETURNING id
  `;
  const lot = await creditLotService.grantFromPayment({
    paymentId: payment!.id,
    userId: fx.userId,
    purchasedCredits: credits,
  });
  if (designateTo !== null) {
    await sql`UPDATE credit_lots SET designated_studio_id = ${designateTo} WHERE id = ${lot.id}`;
  }
  return lot.id;
}

describe("GET /credits/overview", () => {
  it("未登录答 401", async () => {
    const res = await app.request("/api/v1/credits/overview");
    expect(res.status).toBe(401);
  });

  it("分开报「能花的」和「还没指定的」", async () => {
    // 这两个数在新模型里不是一回事，而这正是账号总额答不了的问题：
    // 未指定的钱一分也花不出去。
    const fx = await seedFixture();
    await seedLot(fx, 100, fx.studioId);
    await seedLot(fx, 250);

    const res = await app.request("/api/v1/credits/overview", {
      headers: { Cookie: fx.cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        assignedCredits: number;
        unassignedCredits: number;
        studios: { studioId: string; spendable: number; spent: number }[];
      };
    };
    expect(body.data.assignedCredits).toBe(100);
    expect(body.data.unassignedCredits).toBe(250);
    expect(body.data.studios).toEqual([
      expect.objectContaining({ studioId: fx.studioId, spendable: 100, spent: 0 }),
    ]);
  });

  it("每个 studio 的已消耗只算这个账号出的钱", async () => {
    // studio 转让之后，前任 admin 花掉的那些行还带着这个 studio_id。
    // 少了付款方这个条件，面板会把别人的消耗算进我的账。
    const fx = await seedFixture();
    await seedLot(fx, 100, fx.studioId);
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 30,
    });

    const other = await seedFixture();
    await sql`
      INSERT INTO credit_ledger (payer_user_id, studio_id, entry_type, amount)
      VALUES (${other.userId}, ${fx.studioId}, 'spend', -999)
    `;

    const res = await app.request("/api/v1/credits/overview", {
      headers: { Cookie: fx.cookie },
    });
    const body = (await res.json()) as {
      data: { studios: { studioId: string; spent: number }[] };
    };
    const mine = body.data.studios.find((s) => s.studioId === fx.studioId);
    expect(mine?.spent).toBe(30);
  });
});

describe("GET /credits/lots", () => {
  it("未登录答 401", async () => {
    const res = await app.request("/api/v1/credits/lots");
    expect(res.status).toBe(401);
  });

  it("每笔带买了多少、剩多少、指给谁、状态、被拒过几次退款", async () => {
    // 被拒之后 lifecycle 回到 active，那一格就再也看不出它被拒过 ——
    // 所以痕迹只在这一列上。
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 880, fx.studioId);
    await sql`UPDATE credit_lots SET refund_attempts = 2 WHERE id = ${lotId}`;

    const res = await app.request("/api/v1/credits/lots", {
      headers: { Cookie: fx.cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        items: {
          id: string;
          purchasedCredits: number;
          remainingCredits: number;
          designatedStudioId: string | null;
          lifecycle: string;
          refundAttempts: number;
        }[];
        nextCursor: string | null;
      };
    };
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]).toMatchObject({
      id: lotId,
      purchasedCredits: 880,
      remainingCredits: 880,
      designatedStudioId: fx.studioId,
      lifecycle: "active",
      refundAttempts: 2,
    });
  });

  it("只给自己的笔", async () => {
    const mine = await seedFixture();
    const theirs = await seedFixture();
    await seedLot(theirs, 500);

    const res = await app.request("/api/v1/credits/lots", {
      headers: { Cookie: mine.cookie },
    });
    const body = (await res.json()) as { data: { items: unknown[] } };
    expect(body.data.items).toEqual([]);
  });

  it("按游标翻页，新的在前", async () => {
    const fx = await seedFixture();
    await seedLot(fx, 10);
    await seedLot(fx, 20);
    await seedLot(fx, 30);

    const first = await app.request("/api/v1/credits/lots?limit=2", {
      headers: { Cookie: fx.cookie },
    });
    const firstBody = (await first.json()) as {
      data: { items: { purchasedCredits: number }[]; nextCursor: string | null };
    };
    expect(firstBody.data.items.map((i) => i.purchasedCredits)).toEqual([30, 20]);
    expect(firstBody.data.nextCursor).not.toBeNull();

    const second = await app.request(
      `/api/v1/credits/lots?limit=2&cursor=${encodeURIComponent(firstBody.data.nextCursor!)}`,
      { headers: { Cookie: fx.cookie } },
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      data: { items: { purchasedCredits: number }[]; nextCursor: string | null };
    };
    expect(secondBody.data.items.map((i) => i.purchasedCredits)).toEqual([10]);
    expect(secondBody.data.nextCursor).toBeNull();
  });

  it("几笔时间戳完全相同时也能翻完，不重不漏", async () => {
    // 同一个事务里的 now() 是固定值，所以一次写进多笔时它们的 created_at
    // 一模一样。这时候能把游标断开的只有 id：少了它，翻页要么原地打转，
    // 要么整段跳过。
    const fx = await seedFixture();
    const ids = [
      await seedLot(fx, 11),
      await seedLot(fx, 22),
      await seedLot(fx, 33),
    ];
    await sql`
      UPDATE credit_lots SET created_at = '2026-08-21T00:00:00Z'
      WHERE id = ANY(${sql.array(ids)}::uuid[])
    `;

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const url: string = cursor
        ? `/api/v1/credits/lots?limit=1&cursor=${encodeURIComponent(cursor)}`
        : "/api/v1/credits/lots?limit=1";
      const res = await app.request(url, { headers: { Cookie: fx.cookie } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { items: { id: string }[]; nextCursor: string | null };
      };
      seen.push(...body.data.items.map((i) => i.id));
      cursor = body.data.nextCursor;
      if (cursor === null) break;
    }

    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
    expect([...seen].sort()).toEqual([...ids].sort());
  });
});

describe("GET /credits/ledger", () => {
  it("未登录答 401", async () => {
    const res = await app.request("/api/v1/credits/ledger");
    expect(res.status).toBe(401);
  });

  it("恒按付款方取，每行说得出是谁花的", async () => {
    // 团队里付钱的和花钱的常常不是同一个人。这个视角问的是「我的钱去哪了」。
    const owner = await seedFixture();
    const guest = await seedFixture();
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role)
      VALUES (${owner.studioId}, ${guest.userId}, 'guest')
    `;
    await seedLot(owner, 100, owner.studioId);
    await creditLotService.chargeForGeneration({
      projectId: owner.projectId,
      actorUserId: guest.userId,
      amount: 10,
      referenceId: `routes-charge-${Date.now()}`,
      model: "seedance-1.5-pro",
    });

    const res = await app.request("/api/v1/credits/ledger", {
      headers: { Cookie: owner.cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        items: {
          charged: number;
          consumed: number;
          owed: number;
          actorUserId: string | null;
          actorName: string | null;
          projectId: string | null;
          projectName: string | null;
          studioId: string | null;
          studioName: string | null;
          model: string | null;
        }[];
      };
    };
    // 一次生成一行（#12）：跨几个积分包扣的就写几行，逐行返回会让分页边界
    // 落在一次生成中间。三个金额分开报，是因为「花出去的」和「用掉的」在
    // 欠账时不是一个数。
    expect(body.data.items).toHaveLength(1);
    // 名字随行带出来：界面上要显示「谁」和「哪个 project」，而它手里只有
    // 这一行；让它拿 id 再去问一次，一页三十行就是三十次请求。
    expect(body.data.items[0]).toMatchObject({
      charged: -10,
      consumed: -10,
      owed: 0,
      actorUserId: guest.userId,
      actorName: guest.personalStudioName,
      projectId: owner.projectId,
      projectName: owner.projectName,
      studioId: owner.studioId,
      model: "seedance-1.5-pro",
    });

    // 花钱的那个人自己的账上没有这笔 —— 那不是他的钱。
    const guestRes = await app.request("/api/v1/credits/ledger", {
      headers: { Cookie: guest.cookie },
    });
    const guestBody = (await guestRes.json()) as { data: { items: unknown[] } };
    expect(guestBody.data.items).toEqual([]);
  });

  it("按 studio 筛", async () => {
    const fx = await seedFixture();
    await seedLot(fx, 100, fx.studioId);
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 10,
    });

    const res = await app.request(
      `/api/v1/credits/ledger?studioId=${fx.studioId}`,
      { headers: { Cookie: fx.cookie } },
    );
    const body = (await res.json()) as { data: { items: { studioId: string }[] } };
    expect(body.data.items.length).toBeGreaterThan(0);
    for (const item of body.data.items) expect(item.studioId).toBe(fx.studioId);
  });
});

describe("GET /studio/:slug/credits", () => {
  it("未登录答 401", async () => {
    const fx = await seedFixture();
    const res = await app.request(`/api/v1/studio/${fx.studioSlug}/credits`);
    expect(res.status).toBe(401);
  });

  it("非成员答 403", async () => {
    const fx = await seedFixture();
    const stranger = await seedFixture();
    const res = await app.request(`/api/v1/studio/${fx.studioSlug}/credits`, {
      headers: { Cookie: stranger.cookie },
    });
    expect(res.status).toBe(403);
  });

  it("成员但不是 admin，答 403", async () => {
    // 这一页是 studio 的账本。管钱的是 admin，别人进不来 —— 前端把 tab 藏了，
    // 但地址是手输得到的，所以门必须在服务端。
    const fx = await seedFixture();
    const helper = await seedFixture();
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role)
      VALUES (${fx.studioId}, ${helper.userId}, 'maintainer')
    `;
    const res = await app.request(`/api/v1/studio/${fx.studioSlug}/credits`, {
      headers: { Cookie: helper.cookie },
    });
    expect(res.status).toBe(403);
  });

  it("给 admin 看这个 studio 能花多少、由哪几笔构成、花在哪儿了", async () => {
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 100, fx.studioId);
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 30,
    });

    const res = await app.request(`/api/v1/studio/${fx.studioSlug}/credits`, {
      headers: { Cookie: fx.cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        spendable: number;
        debt: number;
        lots: { id: string; remainingCredits: number; buyerName: string | null }[];
        ledger: {
          items: {
            kind: string;
            charged: number;
            consumed: number;
            owed: number;
            projectName: string | null;
          }[];
        };
      };
    };
    expect(body.data.spendable).toBe(70);
    expect(body.data.debt).toBe(0);
    // 买家的名字是这一块比账号那侧多出来的那一列：同一个 studio 的钱可能是
    // 好几个人各充各的。
    expect(body.data.lots).toEqual([
      expect.objectContaining({
        id: lotId,
        remainingCredits: 70,
        buyerName: fx.personalStudioName,
      }),
    ]);
    expect(body.data.ledger.items).toEqual([
      expect.objectContaining({
        kind: "generation",
        charged: -30,
        consumed: -30,
        owed: 0,
        projectName: fx.projectName,
      }),
    ]);
  });

  it("欠着账时可用额是负数，欠多少单独给一个数", async () => {
    // 两个数字讲同一件事的话，用户还得自己做减法。可用额直接是负的，欠账
    // 那个数是「充值记录」那一块里单独的一行。
    const fx = await seedFixture();
    await seedLot(fx, 30, fx.studioId);
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 350,
      referenceId: `route-owe-${Date.now()}`,
    });

    const res = await app.request(`/api/v1/studio/${fx.studioSlug}/credits`, {
      headers: { Cookie: fx.cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        spendable: number;
        debt: number;
        ledger: { items: { charged: number; consumed: number; owed: number }[] };
      };
    };
    expect(body.data.spendable).toBe(-320);
    expect(body.data.debt).toBe(320);
    expect(body.data.ledger.items).toEqual([
      expect.objectContaining({ charged: -30, consumed: -350, owed: -320 }),
    ]);
  });

  it("积分明细最新的一笔排在最前", async () => {
    // 跟下面的消耗流水同一个方向。设计稿两块都是最新在前，一升一降会让人
    // 以为两块在按不同的东西排。
    const fx = await seedFixture();
    const older = await seedLot(fx, 10, fx.studioId);
    const newer = await seedLot(fx, 20, fx.studioId);
    await sql`
      UPDATE credit_lots SET created_at = '2026-08-04T00:00:00Z' WHERE id = ${older}
    `;
    await sql`
      UPDATE credit_lots SET created_at = '2026-08-19T00:00:00Z' WHERE id = ${newer}
    `;

    const res = await app.request(`/api/v1/studio/${fx.studioSlug}/credits`, {
      headers: { Cookie: fx.cookie },
    });
    const body = (await res.json()) as { data: { lots: { id: string }[] } };

    expect(body.data.lots.map((lot) => lot.id)).toEqual([newer, older]);
  });
});

describe("GET /projects/:id/credits", () => {
  it("未登录答 401", async () => {
    const fx = await seedFixture();
    const res = await app.request(`/api/v1/projects/${fx.projectId}/credits`);
    expect(res.status).toBe(401);
  });

  it("进不了这个 project 的人答 404", async () => {
    // 跟这个 project 的其他读路径一样，无权访问收敛成 404，不泄露它存不存在。
    const fx = await seedFixture();
    const stranger = await seedFixture();
    const res = await app.request(`/api/v1/projects/${fx.projectId}/credits`, {
      headers: { Cookie: stranger.cookie },
    });
    expect(res.status).toBe(404);
  });

  it("给这个 project 的成员看它所属 studio 还能花多少", async () => {
    // 顶栏那个数对所有成员显示。积分页是 admin 一个人的，这个数不是。
    const fx = await seedFixture();
    await seedLot(fx, 100, fx.studioId);
    const helper = await seedFixture();
    await sql`
      INSERT INTO project_members (project_id, user_id, role)
      VALUES (${fx.projectId}, ${helper.userId}, 'viewer')
    `;

    const res = await app.request(`/api/v1/projects/${fx.projectId}/credits`, {
      headers: { Cookie: helper.cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { spendable: number } };
    expect(body.data.spendable).toBe(100);
  });

  it("欠着账时这个数是负的，跟积分页那个数一样", async () => {
    const fx = await seedFixture();
    // 角色住在 `project_members` 上，studio 的 admin 身份不自动带进 project
    // （todo #94 说的就是这条）。
    await sql`
      INSERT INTO project_members (project_id, user_id, role)
      VALUES (${fx.projectId}, ${fx.userId}, 'owner')
    `;
    await seedLot(fx, 30, fx.studioId);
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 350,
      referenceId: `top-owe-${Date.now()}`,
    });

    const res = await app.request(`/api/v1/projects/${fx.projectId}/credits`, {
      headers: { Cookie: fx.cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { spendable: number } };
    expect(body.data.spendable).toBe(-320);
  });
});

describe("坏输入不该 500", () => {
  it("路径里不是 uuid 时答 422，不是 500", async () => {
    const fx = await seedFixture();
    const res = await app.request("/api/v1/credits/lots/not-a-uuid/designation", {
      method: "PATCH",
      headers: { Cookie: fx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ studioId: null }),
    });
    expect(res.status).toBe(422);
  });

  it("结构合法但用不了的游标当第一页，不是 500", async () => {
    // 游标从网络上来，什么形状都可能。下面五种各卡在解码器的一道校验上：
    // 时间戳不是字符串、形状对但月份越界、二月三十号（Date.parse 会把它
    // 滚到三月，所以只靠它挡不住）、时区偏移越界、id 不是 uuid。
    // 每一种到了数据库都是一次失败的查询。
    const fx = await seedFixture();
    await seedLot(fx, 100);
    const uuid = crypto.randomUUID();
    const bad = [
      Buffer.from(JSON.stringify({ c: 1, i: "x" })).toString("base64url"),
      Buffer.from(JSON.stringify({ c: "2026-13-04 03:00:00+00", i: uuid })).toString("base64url"),
      Buffer.from(JSON.stringify({ c: "2026-02-30 00:00:00+00", i: uuid })).toString("base64url"),
      Buffer.from(JSON.stringify({ c: "2026-07-04 03:00:00+99", i: uuid })).toString("base64url"),
      Buffer.from(JSON.stringify({ c: "2026-07-04 03:00:00+00", i: "not-a-uuid" })).toString("base64url"),
    ];
    for (const cursor of bad) {
      for (const url of ["/api/v1/credits/lots", "/api/v1/credits/ledger"]) {
        const res = await app.request(`${url}?cursor=${encodeURIComponent(cursor)}`, {
          headers: { Cookie: fx.cookie },
        });
        expect(res.status, `${url} 收到 ${cursor}`).toBe(200);
      }
    }
  });

  it("用不了的游标，整页都按第一页答", async () => {
    // 「是不是第一页」被问了两次：这个端点问原始字符串在不在，而流水那半
    // 问的是解码之后还剩什么。一个结构合法、解码后用不了的游标恰好让两个
    // 答案相反 —— 流水照第一页查了，可用额和充值记录被当成翻页省掉，页面
    // 上那两块就空着。
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 100, fx.studioId);
    const unusable = Buffer.from(
      JSON.stringify({ c: Date.now(), i: "not-a-uuid" }),
    ).toString("base64url");

    const res = await app.request(
      `/api/v1/studio/${fx.studioSlug}/credits?cursor=${encodeURIComponent(unusable)}`,
      { headers: { Cookie: fx.cookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { spendable?: number; lots?: { id: string }[] };
    };
    expect(body.data.spendable).toBe(100);
    expect(body.data.lots).toEqual([expect.objectContaining({ id: lotId })]);
  });

  it("带游标翻页时不重发这个 studio 的全部笔", async () => {
    // 客户端只读第一页那份 lots，后面每页都重算重传是白跑。
    const fx = await seedFixture();
    await seedLot(fx, 100, fx.studioId);
    // The timestamp is the text Postgres renders, which is what the cursor
    // carries so the microseconds survive the round trip.
    const cursor = Buffer.from(
      JSON.stringify({ c: "2026-08-22 10:00:00.123456+00", i: crypto.randomUUID() }),
    ).toString("base64url");

    const res = await app.request(
      `/api/v1/studio/${fx.studioSlug}/credits?cursor=${encodeURIComponent(cursor)}`,
      { headers: { Cookie: fx.cookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { lots?: unknown } };
    expect(body.data.lots).toBeUndefined();
  });
});

describe("PATCH /credits/lots/:id/designation", () => {
  it("未登录答 401", async () => {
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 100);
    const res = await app.request(`/api/v1/credits/lots/${lotId}/designation`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studioId: fx.studioId }),
    });
    expect(res.status).toBe(401);
  });

  it("指给自己管理的 studio，钱当场可花", async () => {
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 100);

    const res = await app.request(`/api/v1/credits/lots/${lotId}/designation`, {
      method: "PATCH",
      headers: { Cookie: fx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ studioId: fx.studioId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { designatedStudioId: string } };
    expect(body.data.designatedStudioId).toBe(fx.studioId);
    expect(await creditLotService.getSpendableCredits(fx.studioId)).toBe(100);
  });

  it("目标 studio 自己不是 admin 时答 403", async () => {
    const fx = await seedFixture();
    const other = await seedFixture();
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role)
      VALUES (${other.studioId}, ${fx.userId}, 'maintainer')
    `;
    const lotId = await seedLot(fx, 100);

    const res = await app.request(`/api/v1/credits/lots/${lotId}/designation`, {
      method: "PATCH",
      headers: { Cookie: fx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ studioId: other.studioId }),
    });
    expect(res.status).toBe(403);
  });

  it("动别人的笔答 404", async () => {
    const owner = await seedFixture();
    const stranger = await seedFixture();
    const lotId = await seedLot(owner, 100);

    const res = await app.request(`/api/v1/credits/lots/${lotId}/designation`, {
      method: "PATCH",
      headers: { Cookie: stranger.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ studioId: stranger.studioId }),
    });
    expect(res.status).toBe(404);
  });

  it("退款流程里的笔答 409", async () => {
    // 这笔未指定：申请退款那一刻它就跟原来的 studio 解除了关系，0063 的
    // CHECK 看着这一条。它想再进任何一个池子都要等退款有结果。
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 100);
    await sql`UPDATE credit_lots SET lifecycle = 'refund_pending' WHERE id = ${lotId}`;

    const res = await app.request(`/api/v1/credits/lots/${lotId}/designation`, {
      method: "PATCH",
      headers: { Cookie: fx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ studioId: fx.studioId }),
    });
    expect(res.status).toBe(409);
  });

  it("重复提交同一个目标，结果一样", async () => {
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 100, fx.studioId);

    const send = async (): Promise<Response> =>
      app.request(`/api/v1/credits/lots/${lotId}/designation`, {
        method: "PATCH",
        headers: { Cookie: fx.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ studioId: fx.studioId }),
      });

    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
  });

  it("传 null 把它收回未指定", async () => {
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 100, fx.studioId);

    const res = await app.request(`/api/v1/credits/lots/${lotId}/designation`, {
      method: "PATCH",
      headers: { Cookie: fx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ studioId: null }),
    });
    expect(res.status).toBe(200);
    expect(await creditLotService.getSpendableCredits(fx.studioId)).toBe(0);
  });

  it("body 里没有 studioId 时答 422，不当成取消指定", async () => {
    // 缺字段和显式给 null 是两回事：一个是请求写错了，一个是「收回来」。
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 100, fx.studioId);

    const res = await app.request(`/api/v1/credits/lots/${lotId}/designation`, {
      method: "PATCH",
      headers: { Cookie: fx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
    expect(await creditLotService.getSpendableCredits(fx.studioId)).toBe(100);
  });
});
