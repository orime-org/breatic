// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 积分引擎跑在真 Postgres 上（任务 #11）。
 *
 * 这一层的保证全是 SQL 级的，替身答不出来：取笔的顺序、跨笔摊扣、行锁拿到
 * 之后的复核、以及「剩余恒等于流水求和」这条逐笔对账。用 mock 的查询构造器
 * 测它们，等于让测试自己回答自己的问题。
 *
 * 每个用例各自建自己的用户、studio 和笔，不共享夹具 —— 集成测试是单进程串行
 * 跑的，但共享夹具会让「先充先花」这类跟顺序有关的断言依赖别的用例留下的行。
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

import fc from "fast-check";
import postgres from "postgres";
import { initCore, env, loadLocales } from "@breatic/core";
import { creditLotService, creditLotRepo } from "@breatic/domain";
import type { ActivityCursor } from "@breatic/core";
import { waitUntilBlockedOn } from "@server/__tests__/integration/lock-probe.js";

const PG_DRIVER_LOCAL = "credit-engine-test-driver";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  // 支付开着才有「扣费」这件事。本地和自部署默认是关的，那条路径另有一个
  // 用例专门测。这套件一次 Stripe 都不碰 —— 扣费全在我们自己的库里 ——
  // 所以两个占位密钥只是为了过启动时那道「开了支付就必须有密钥」的校验。
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
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  // 把开关放回去，免得同一个 worker 里的下一个套件读到我们改过的样子。
  initCore(process.env);
});

let seq = 0;

interface Fixture {
  userId: string;
  studioId: string;
  projectId: string;
  projectName: string;
}

/** 一个用户 + 他管理的 studio + 该 studio 下的一个 project。 */
async function seedFixture(): Promise<Fixture> {
  const n = seq++;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`engine-${n}-${Date.now()}@example.test`}, true) RETURNING id
  `;
  const userId = user!.id;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`engine-s-${n}-${Date.now()}`}, 'team', 'Engine') RETURNING id
  `;
  const studioId = studio!.id;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studioId}, ${userId}, 'admin')
  `;
  const projectName = `Engine 项目 ${n}`;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, slug, name)
    VALUES (${studioId}, ${userId}, ${`engine-p-${n}-${Date.now()}`}, ${projectName})
    RETURNING id
  `;
  return { userId, studioId, projectId: project!.id, projectName };
}

/** 另建一个由 `userId` 管理的 studio（一个 studio 只能有一个 admin）。 */
async function seedStudioAdministeredBy(userId: string): Promise<string> {
  const n = seq++;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`engine-s2-${n}-${Date.now()}`}, 'team', 'Second') RETURNING id
  `;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studio!.id}, ${userId}, 'admin')
  `;
  return studio!.id;
}

/** 一笔已到账的付款，落成一笔 lot；`studioId` 给了就顺手指定给它。 */
async function seedLot(
  fx: Fixture,
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
    await sql`
      UPDATE credit_lots SET designated_studio_id = ${designateTo} WHERE id = ${lot.id}
    `;
  }
  return lot.id;
}

/** 一笔现在的剩余与状态。 */
async function readLot(
  lotId: string,
): Promise<{ remaining: string; lifecycle: string; studio: string | null }> {
  const [row] = await sql<
    { remaining_credits: string; lifecycle: string; designated_studio_id: string | null }[]
  >`
    SELECT remaining_credits, lifecycle, designated_studio_id
    FROM credit_lots WHERE id = ${lotId}
  `;
  return {
    remaining: row!.remaining_credits,
    lifecycle: row!.lifecycle,
    studio: row!.designated_studio_id,
  };
}

/** 逐笔对账：这一笔的流水求和。 */
async function ledgerSum(lotId: string): Promise<string> {
  const [row] = await sql<{ total: string }[]>`
    SELECT COALESCE(SUM(amount), 0)::text AS total
    FROM credit_ledger WHERE lot_id = ${lotId}
  `;
  return row!.total;
}

describe("这套件测的是支付开着的那条路径", () => {
  it("开关确实是开的", () => {
    // 少了这一条，扣费的每一条断言都可能在测「支付关闭」那个分支，
    // 而那个分支一分不扣、照样返回成功。
    expect(env.PAYMENT_ENABLED).toBe(true);
  });
});

describe("充值到账", () => {
  it("建出一笔，未指定，并写一行 topup 流水", async () => {
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 880);

    const lot = await readLot(lotId);
    expect(lot.remaining).toBe("880.000000");
    expect(lot.lifecycle).toBe("active");
    // 未指定是它唯一的出生状态：一个人可能连着充好几笔，充值流程里不问归属。
    expect(lot.studio).toBeNull();

    const [entry] = await sql<{ entry_type: string; amount: string }[]>`
      SELECT entry_type, amount FROM credit_ledger WHERE lot_id = ${lotId}
    `;
    expect(entry?.entry_type).toBe("topup");
    expect(entry?.amount).toBe("880.000000");
  });

  it("同一笔付款再来一次会被拒，不会发第二次积分", async () => {
    const fx = await seedFixture();
    const [payment] = await sql<{ id: string }[]>`
      INSERT INTO payments (user_id, amount_cents, status, credits_granted)
      VALUES (${fx.userId}, 1000, 'completed', 880) RETURNING id
    `;
    await creditLotService.grantFromPayment({
      paymentId: payment!.id,
      userId: fx.userId,
      purchasedCredits: 880,
    });

    const replay = await creditLotService
      .grantFromPayment({
        paymentId: payment!.id,
        userId: fx.userId,
        purchasedCredits: 880,
      })
      .then(
        () => null,
        (err: unknown) => err,
      );
    // drizzle 把驱动的报错包了一层，唯一约束的名字在 cause 上。指名它，
    // 免得这条断言被别的插入失败满足。
    expect(String((replay as { cause?: unknown })?.cause ?? replay)).toMatch(
      /credit_lots_payment_id_idx/,
    );

    const counted = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM credit_lots WHERE payment_id = ${payment!.id}
    `;
    expect(counted[0]?.count).toBe("1");
  });
});

describe("扣费", () => {
  it("先充的先花", async () => {
    const fx = await seedFixture();
    const older = await seedLot(fx, 100, fx.studioId);
    // created_at 由数据库给，两笔可能落在同一微秒上，所以显式拉开。
    await sql`UPDATE credit_lots SET created_at = NOW() - INTERVAL '1 hour' WHERE id = ${older}`;
    const newer = await seedLot(fx, 100, fx.studioId);

    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 30,
    });

    expect((await readLot(older)).remaining).toBe("70.000000");
    expect((await readLot(newer)).remaining).toBe("100.000000");
  });

  it("一笔不够时摊到下一笔，各写一行流水", async () => {
    const fx = await seedFixture();
    const first = await seedLot(fx, 30, fx.studioId);
    await sql`UPDATE credit_lots SET created_at = NOW() - INTERVAL '1 hour' WHERE id = ${first}`;
    const second = await seedLot(fx, 100, fx.studioId);

    const outcome = await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 50,
      referenceId: `task-${Date.now()}`,
    });

    expect(outcome.charged).toBe(50);
    expect(outcome.shortfall).toBe(0);
    expect(outcome.lotIds).toEqual([first, second]);

    // 花光的那笔转 depleted —— 剩余为零和「不能再从它取」是同一件事，
    // 分两次写就会有查询只看见其中一个。
    expect(await readLot(first)).toMatchObject({
      remaining: "0.000000",
      lifecycle: "depleted",
    });
    expect((await readLot(second)).remaining).toBe("80.000000");
  });

  it("每一笔的剩余恒等于它自己的流水求和", async () => {
    const fx = await seedFixture();
    const first = await seedLot(fx, 30, fx.studioId);
    await sql`UPDATE credit_lots SET created_at = NOW() - INTERVAL '1 hour' WHERE id = ${first}`;
    const second = await seedLot(fx, 100, fx.studioId);

    for (const amount of [12.5, 20.25, 7.125]) {
      await creditLotService.chargeForGeneration({
        projectId: fx.projectId,
        actorUserId: fx.userId,
        amount,
      });
    }

    // 充值那一行本身带着 lot_id，所以它已经在求和里，不再单独加购买额。
    for (const lotId of [first, second]) {
      expect(await ledgerSum(lotId)).toBe((await readLot(lotId)).remaining);
    }
  });

  it("不取未指定的笔——列为 null 的那一条腿", async () => {
    const fx = await seedFixture();
    const unassigned = await seedLot(fx, 500);

    const outcome = await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 10,
    });

    expect(outcome.charged).toBe(0);
    expect(outcome.shortfall).toBe(10);
    expect((await readLot(unassigned)).remaining).toBe("500.000000");
  });

  it("不取指向已软删 studio 的笔——未指定的另一条腿", async () => {
    // studio 走软删、外键是 restrict，所以删掉之后这一列还指着它。
    // 这笔一分也花不出去，读侧一律当未指定看待。
    const fx = await seedFixture();
    const other = await seedFixture();
    const lotId = await seedLot(fx, 500, other.studioId);
    await sql`UPDATE studios SET deleted_at = NOW() WHERE id = ${other.studioId}`;

    const spendable = await creditLotService.getSpendableCredits(other.studioId);
    expect(spendable).toBe(0);

    const unassigned = await creditLotService.getUnassignedCredits(fx.userId);
    expect(unassigned).toBe(500);
    expect((await readLot(lotId)).remaining).toBe("500.000000");
  });

  it("取笔这一层自己就滤掉指向已软删 studio 的笔", async () => {
    // 上面那条走的是求和，这条走的是真正决定「能扣哪几笔」的那个查询。
    // 少了这条，取笔里那道软删过滤没有任何断言看着它，而它一旦掉了，
    // 一个已经不存在的 studio 的池子照样会被扣。
    const fx = await seedFixture();
    const other = await seedFixture();
    await seedLot(fx, 500, other.studioId);
    await sql`UPDATE studios SET deleted_at = NOW() WHERE id = ${other.studioId}`;

    expect(await creditLotRepo.listSpendableLots(other.studioId)).toEqual([]);
  });

  it("笔加起来不够时能扣多少扣多少，差额报出来而不是失败", async () => {
    // 这一层跑在交付之后：用户已经拿到产物，任务不能因为账不够而失败。
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 30, fx.studioId);

    const outcome = await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 100,
    });

    expect(outcome.charged).toBe(30);
    expect(outcome.shortfall).toBe(70);
    expect((await readLot(lotId)).lifecycle).toBe("depleted");
  });

  it("记下是谁花的，也记下花的是谁的钱", async () => {
    // 团队里这两个人常常不是同一个：studio 的访客在某个 project 里是
    // editor，他生成时花的是 admin 的钱。
    const owner = await seedFixture();
    const guest = await seedFixture();
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role)
      VALUES (${owner.studioId}, ${guest.userId}, 'guest')
    `;
    const lotId = await seedLot(owner, 100, owner.studioId);

    await creditLotService.chargeForGeneration({
      projectId: owner.projectId,
      actorUserId: guest.userId,
      amount: 10,
    });

    const [row] = await sql<
      { payer_user_id: string; actor_user_id: string; studio_id: string }[]
    >`
      SELECT payer_user_id, actor_user_id, studio_id
      FROM credit_ledger WHERE lot_id = ${lotId} AND entry_type = 'spend'
    `;
    expect(row?.payer_user_id).toBe(owner.userId);
    expect(row?.actor_user_id).toBe(guest.userId);
    expect(row?.studio_id).toBe(owner.studioId);
  });
});

describe("扣不到笔时的记账", () => {
  it("project 在任务跑的过程中被软删，用量记录照写", async () => {
    // 产物已经交付了。定稿给「取不到笔」定的两种形态都要求写用量记录，
    // 而解析 studio 是这条路上的第一步——它抛异常，整条记账就断在写记录之前。
    const fx = await seedFixture();
    await seedLot(fx, 100, fx.studioId);
    await sql`UPDATE projects SET deleted_at = NOW() WHERE id = ${fx.projectId}`;

    const outcome = await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 10,
      referenceId: `gone-${Date.now()}`,
    });

    expect(outcome).toMatchObject({ billed: false, charged: 0, shortfall: 10 });
    const [row] = await sql<{ lot_id: string | null; studio_id: string | null }[]>`
      SELECT lot_id, studio_id FROM credit_ledger
      WHERE payer_user_id = ${fx.userId} AND entry_type = 'spend'
    `;
    expect(row?.lot_id).toBeNull();
    expect(row?.studio_id).toBeNull();
  });
});

describe("总览的两个数", () => {
  it("「花了多少」把扣不满的那部分算作 studio 的欠账，不算进已消耗", async () => {
    // 池子花光之后那次生成写的是 debt_incurred，它不在已消耗统计的两种
    // entry_type 里，所以已消耗停在真扣到的 30。
    const fx = await seedFixture();
    await seedLot(fx, 100, fx.studioId);
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 30,
    });
    // 池子花光之后再生成一次：写用量、一分不扣。
    await sql`UPDATE credit_lots SET remaining_credits = 0, lifecycle = 'depleted' WHERE user_id = ${fx.userId}`;
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 999,
    });

    const overview = await creditLotService.getOverview(fx.userId);
    const mine = overview.studios.find((s) => s.studioId === fx.studioId);
    expect(mine?.spent).toBe(30);
  });

  it("抵掉欠账的那部分算在「花了多少」里，两个数加起来等于买的数", async () => {
    // 抵债跟正常生成一样从一笔里扣走了钱，只是先记成欠账、后从笔里拿。
    // 不算它，同一笔钱走两条路会得出两个不同的账面。
    const fx = await seedFixture();
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 300,
      referenceId: `owe-${Date.now()}`,
    });
    const lotId = await seedLot(fx, 1000);
    await creditLotService.designateLot({
      lotId,
      requestingUserId: fx.userId,
      studioId: fx.studioId,
    });

    const overview = await creditLotService.getOverview(fx.userId);
    const mine = overview.studios.find((s) => s.studioId === fx.studioId);
    expect(mine?.spent).toBe(300);
    expect((mine?.spendable ?? 0) + (mine?.spent ?? 0)).toBe(1000);
  });

  it("充值记录照样列出已经花光的笔", async () => {
    // 这一块记的是进来的水：谁充的、充了多少、还剩多少。一笔花光了，它仍然
    // 是这个 studio 收到过的一笔充值 —— 已确认的 demo 第二行画的就是一笔
    // remaining 为 0 的。把它拿掉，花光积分的 studio 会看到一块空白，而正
    // 下方的流水正列着那笔钱花出去的每一行。
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 100, fx.studioId);
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 100,
    });

    expect((await readLot(lotId)).lifecycle).toBe("depleted");
    const purchases = await creditLotRepo.listLotsByStudio(fx.studioId);
    expect(purchases).toEqual([
      expect.objectContaining({
        id: lotId,
        remainingCredits: "0.000000",
        purchasedCredits: "100.000000",
      }),
    ]);
  });

  it("adds the purchase block up to the figure at the top of the page", async () => {
    // The block exists to explain that figure, so the two are computed by
    // different queries on purpose: the top is `sumSpendableForStudio` (active
    // lots only) less the debt, the block is every lot designated here right
    // now plus the debt line. They agree only while a depleted lot always has
    // nothing left on it, which no constraint enforces.
    const fx = await seedFixture();
    await seedLot(fx, 100, fx.studioId);
    await seedLot(fx, 250, fx.studioId);
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 130,
      referenceId: `sum-a-${Date.now()}`,
    });

    const addUp = async (): Promise<number> => {
      const purchases = await creditLotRepo.listLotsByStudio(fx.studioId);
      const lots = purchases.reduce((n, lot) => n + Number(lot.remainingCredits), 0);
      return lots - (await creditLotService.getStudioDebt(fx.studioId));
    };

    // A lot fully drained, one partly drained, no debt.
    expect(await addUp()).toBe(await creditLotService.getSpendableCredits(fx.studioId));

    // And once the studio owes: every lot at zero, the debt line carrying it.
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 400,
      referenceId: `sum-b-${Date.now()}`,
    });
    expect(await creditLotService.getStudioDebt(fx.studioId)).toBeGreaterThan(0);
    expect(await addUp()).toBe(await creditLotService.getSpendableCredits(fx.studioId));
  });

  it("充值记录带着每一笔是谁买的", async () => {
    // demo 每行第一格就是买家的名字。显示名住在个人 studio 上，跟流水取
    // 操作人名字同一处。
    const fx = await seedFixture();
    const buyerName = `买家 ${seq}`;
    await sql`
      INSERT INTO studios (created_by_user_id, slug, type, name)
      VALUES (${fx.userId}, ${`engine-me-${seq++}-${Date.now()}`}, 'personal', ${buyerName})
    `;
    const lotId = await seedLot(fx, 880, fx.studioId);

    const purchases = await creditLotRepo.listLotsByStudio(fx.studioId);
    expect(purchases).toEqual([
      expect.objectContaining({ id: lotId, buyerName }),
    ]);
  });

  it("充值记录不列指向已软删 studio 的笔", async () => {
    const fx = await seedFixture();
    await seedLot(fx, 100, fx.studioId);
    await sql`UPDATE studios SET deleted_at = NOW() WHERE id = ${fx.studioId}`;

    expect(await creditLotRepo.listLotsByStudio(fx.studioId)).toEqual([]);
  });
});

describe("指定", () => {
  it("把一笔指给自己管理的 studio", async () => {
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 100);

    const lot = await creditLotService.designateLot({
      lotId,
      requestingUserId: fx.userId,
      studioId: fx.studioId,
    });
    expect(lot.designatedStudioId).toBe(fx.studioId);
    expect(await creditLotService.getSpendableCredits(fx.studioId)).toBe(100);
  });

  it("改指定之后原 studio 立刻失去这一笔", async () => {
    const fx = await seedFixture();
    const secondStudioId = await seedStudioAdministeredBy(fx.userId);
    const lotId = await seedLot(fx, 100, fx.studioId);

    await creditLotService.designateLot({
      lotId,
      requestingUserId: fx.userId,
      studioId: secondStudioId,
    });

    expect(await creditLotService.getSpendableCredits(fx.studioId)).toBe(0);
    expect(await creditLotService.getSpendableCredits(secondStudioId)).toBe(100);
  });

  it("指给自己不是 admin 的 studio 会被拒", async () => {
    const fx = await seedFixture();
    const other = await seedFixture();
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role)
      VALUES (${other.studioId}, ${fx.userId}, 'maintainer')
    `;
    const lotId = await seedLot(fx, 100);

    await expect(
      creditLotService.designateLot({
        lotId,
        requestingUserId: fx.userId,
        studioId: other.studioId,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("动别人的笔答 404，不告诉他这个 id 存不存在", async () => {
    const owner = await seedFixture();
    const stranger = await seedFixture();
    const lotId = await seedLot(owner, 100);

    await expect(
      creditLotService.designateLot({
        lotId,
        requestingUserId: stranger.userId,
        studioId: stranger.studioId,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("退款流程里的笔不许改指定", async () => {
    // 这笔未指定，因为申请退款那一刻它就跟原来的 studio 解除了关系
    // （0063 的 CHECK 看着这一条）。它想再进任何一个池子，都要等退款有
    // 结果 —— 这段时间里这笔钱正在往账外走。
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 100);
    await sql`UPDATE credit_lots SET lifecycle = 'refunding' WHERE id = ${lotId}`;

    await expect(
      creditLotService.designateLot({
        lotId,
        requestingUserId: fx.userId,
        studioId: fx.studioId,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("对已经未指定的笔再提交一次未指定，答成功且什么都不变", async () => {
    // 契约声明这个操作是幂等的：丢了响应之后的重试不能读成冲突。
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 100);

    const lot = await creditLotService.designateLot({
      lotId,
      requestingUserId: fx.userId,
      studioId: null,
    });
    expect(lot.designatedStudioId).toBeNull();
  });
});

/**
 * 闸门 3：占着这个 studio 欠账行的唯一索引，但不提交。
 *
 * 跟 {@link holdDebtLock} 的区别在卡住的位置：那个先把行插好、让两边争
 * `FOR UPDATE`；这个让行始终不存在，两边卡在 `INSERT ... ON CONFLICT` 的唯一
 * 索引上。放闸门时回滚，于是先到的那个真的建出这一行，后到的那个走 DO NOTHING
 * 之后还要再等它提交 —— 这正是「首次欠账」那一格的形状。
 * @param studioId - 要卡住的 studio。
 * @returns 回滚闸门事务的函数。
 * @throws {Error} 闸门的插入没能在超时内落到未提交状态时。
 */
async function holdDebtRowInsert(
  studioId: string,
): Promise<() => Promise<void>> {
  const gate = postgres(inject("DATABASE_URL"), {
    max: 1,
    prepare: false,
    connection: { application_name: `${PG_DRIVER_LOCAL}-debt-insert-gate` },
  });
  let release: (reason?: unknown) => void = () => {};
  const held = new Promise<void>((_, reject) => {
    release = reject;
  });
  let inserted: () => void = () => {};
  const rowClaimed = new Promise<void>((resolve) => {
    inserted = resolve;
  });
  const done = gate
    .begin(async (tx) => {
      await tx`
        INSERT INTO studio_credit_debts (studio_id, amount)
        VALUES (${studioId}, 0)
      `;
      inserted();
      await held;
    })
    .catch(() => undefined);
  await rowClaimed;
  return async () => {
    release(new Error("gate rollback"));
    await done;
    await gate.end({ timeout: 1 });
  };
}

/**
 * 闸门 2：持住这个 studio 的欠账行，两条写路径的第一把锁都在它上面。
 * @param studioId - 要卡住的 studio。
 * @returns 放闸门的函数。
 */
async function holdDebtLock(studioId: string): Promise<() => Promise<void>> {
  const gate = postgres(inject("DATABASE_URL"), {
    max: 1,
    prepare: false,
    connection: { application_name: `${PG_DRIVER_LOCAL}-debt-gate` },
  });
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let acquired: () => void = () => {};
  const lockHeld = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  await sql`
    INSERT INTO studio_credit_debts (studio_id, amount) VALUES (${studioId}, 0)
    ON CONFLICT (studio_id) DO NOTHING
  `;
  const done = gate.begin(async (tx) => {
    await tx`SELECT id FROM studio_credit_debts WHERE studio_id = ${studioId} FOR UPDATE`;
    acquired();
    await held;
  });
  await lockHeld;
  return async () => {
    release();
    await done;
    await gate.end({ timeout: 1 });
  };
}

describe("并发", () => {
  /**
   * 另开一条连接把某一笔的行锁攥住，当作闸门。
   *
   * `Promise.all` 起两个短事务造不出交错：第一个跑得太快，连接还回池里
   * 第二个才来申请，两个事务落在同一条连接上，数据库层面压根没有并发。
   * 攥住行锁能让被测的那一方**真的**停在锁上，而这件事由探针查
   * `pg_stat_activity` 确认，不靠 sleep。
   * @param lotId - 要攥住的那一笔。
   * @returns 放闸门的函数。
   */

  async function holdLotLock(lotId: string): Promise<() => Promise<void>> {
    const gate = postgres(inject("DATABASE_URL"), {
      max: 1,
      prepare: false,
      connection: { application_name: `${PG_DRIVER_LOCAL}-gate` },
    });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired: () => void = () => {};
    // 等的是「闸门真的拿到了锁」这件事本身。等固定毫秒数在负载高的机器上
    // 会放被测方先跑完，于是它一次都没停在锁上，而测试报的是探针超时。
    const lockHeld = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const done = gate.begin(async (tx) => {
      await tx`SELECT id FROM credit_lots WHERE id = ${lotId} FOR UPDATE`;
      acquired();
      await held;
    });
    await lockHeld;
    return async () => {
      release();
      await done;
      await gate.end({ timeout: 1 });
    };
  }

  it("两个并发扣费不会把同一笔重复花掉", async () => {
    // 闸门卡在欠账行上，因为那是扣费拿的第一把锁。挪到这里之后，同一个
    // studio 上的两个扣费在进笔之前就排好了队。
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 100, fx.studioId);
    const open = await holdDebtLock(fx.studioId);

    // 两次都要 60，而这一笔只有 100。谁也不许读到没被对方扣过的余额。
    const first = creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 60,
    });
    await waitUntilBlockedOn(sql, ["studio_credit_debts", "for update"], 1);
    const second = creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 60,
    });
    await waitUntilBlockedOn(sql, ["studio_credit_debts", "for update"], 2);

    await open();
    const [a, b] = await Promise.all([first, second]);

    expect(a.charged + b.charged).toBe(100);
    expect(a.shortfall + b.shortfall).toBe(20);
    expect(await readLot(lotId)).toMatchObject({
      remaining: "0.000000",
      lifecycle: "depleted",
    });
    expect(await ledgerSum(lotId)).toBe("0.000000");
  });

  it("一笔在被选中和被锁住之间改了指定，原 studio 就扣不到它了", async () => {
    // 取笔那一步不加锁，所以扣费方看到的是改指定之前的样子。锁到之后必须
    // 重读这一列 —— 不重读，一笔刚刚归了别人的钱还是会被原 studio 花掉。
    const fx = await seedFixture();
    const secondStudioId = await seedStudioAdministeredBy(fx.userId);
    const lotId = await seedLot(fx, 100, fx.studioId);
    const open = await holdLotLock(lotId);

    const designating = creditLotService.designateLot({
      lotId,
      requestingUserId: fx.userId,
      studioId: secondStudioId,
    });
    await waitUntilBlockedOn(sql, ["credit_lots", "for update"], 1);
    const charging = creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 40,
    });
    await waitUntilBlockedOn(sql, ["credit_lots", "for update"], 2);

    await open();
    await designating;
    const outcome = await charging;

    expect(outcome.charged).toBe(0);
    expect(outcome.shortfall).toBe(40);
    expect(await readLot(lotId)).toMatchObject({
      remaining: "100.000000",
      studio: secondStudioId,
    });
  });

});

/** 这个 studio 现在欠多少，直接读表。 */
async function readDebt(studioId: string): Promise<string> {
  const [row] = await sql<{ amount: string }[]>`
    SELECT amount FROM studio_credit_debts WHERE studio_id = ${studioId}
  `;
  return row?.amount ?? "0";
}

/** 欠账两类流水的求和，用来验不变量 3。 */
async function debtLedgerSums(
  studioId: string,
): Promise<{ incurred: string; repayment: string }> {
  const [row] = await sql<{ incurred: string; repayment: string }[]>`
    SELECT
      COALESCE(SUM(amount) FILTER (WHERE entry_type = 'debt_incurred'), 0)::text
        AS incurred,
      COALESCE(SUM(amount) FILTER (WHERE entry_type = 'debt_repayment'), 0)::text
        AS repayment
    FROM credit_ledger WHERE studio_id = ${studioId}
  `;
  return { incurred: row!.incurred, repayment: row!.repayment };
}

describe("欠账：状态转移表逐格", () => {
  it("无欠账 + 全额扣到 → 仍无欠账", async () => {
    const fx = await seedFixture();
    await seedLot(fx, 100, fx.studioId);

    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 30,
    });

    expect(await readDebt(fx.studioId)).toBe("0.000000");
    expect(await creditLotService.getStudioDebt(fx.studioId)).toBe(0);
  });

  it("无欠账 + 扣不满 → 欠账等于差额", async () => {
    // 预检要的是一个下限，账单是实际用量。余额见底时点一次生成，零并发就能
    // 欠出几十分 —— 这是这套机制存在的理由本身。
    const fx = await seedFixture();
    await seedLot(fx, 30, fx.studioId);

    const outcome = await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 350,
      referenceId: `short-${Date.now()}`,
    });

    expect(outcome.charged).toBe(30);
    expect(outcome.shortfall).toBe(320);
    expect(await creditLotService.getStudioDebt(fx.studioId)).toBe(320);
  });

  it("无欠账 + 指定一笔进来 → 仍无欠账，这笔一分不动", async () => {
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 100);

    await creditLotService.designateLot({
      lotId,
      requestingUserId: fx.userId,
      studioId: fx.studioId,
    });

    expect(await creditLotService.getStudioDebt(fx.studioId)).toBe(0);
    expect((await readLot(lotId)).remaining).toBe("100.000000");
  });

  it("clears the pool and leaves no debt when a lot is undesignated", async () => {
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 100, fx.studioId);
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 30,
      referenceId: `undesignate-${Date.now()}`,
    });
    expect(Number(await creditLotRepo.sumSpendableForStudio(fx.studioId))).toBe(70);

    await creditLotService.designateLot({
      lotId,
      requestingUserId: fx.userId,
      studioId: null,
    });

    // Read through the purchase predicate as well: it ignores lifecycle, so an
    // empty list can only mean the designation is gone.
    expect(await creditLotRepo.listLotsByStudio(fx.studioId)).toEqual([]);
    expect(Number(await creditLotRepo.sumSpendableForStudio(fx.studioId))).toBe(0);
    expect(await creditLotService.getStudioDebt(fx.studioId)).toBe(0);
  });

  it("refuses to leave a lot designated once a refund is asked for", async () => {
    // Every read of a studio's credits starts from the designation, so a lot
    // on its way out of the account has to lose it. That is not a rule the
    // read side can enforce — it would have to name the refund lifecycles in
    // each of its predicates, and one of them forgetting is a studio that can
    // spend money already being returned. The table refuses the state
    // instead (0063), so the rule holds for every path that writes it,
    // including ones written after this test.
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 100, fx.studioId);

    await expect(
      sql`
        UPDATE credit_lots
        SET lifecycle = 'refund_pending'
        WHERE id = ${lotId}
      `,
    ).rejects.toThrow(/credit_lots_refund_undesignated/);

    // The refused write left the row alone: the studio still holds it.
    expect(Number(await creditLotRepo.sumSpendableForStudio(fx.studioId))).toBe(
      100,
    );
  });

  it("keeps a rejected refund out of the studio it came from", async () => {
    // This is the counterexample the refund rule exists to close: a rejected
    // refund returns the lot to `active` with its balance intact, and if it
    // came back designated the studio would suddenly have credits again.
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 100, fx.studioId);
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 30,
      referenceId: `reject-owe-${Date.now()}`,
    });

    await sql`
      UPDATE credit_lots
      SET lifecycle = 'refund_pending', designated_studio_id = NULL
      WHERE id = ${lotId}
    `;
    await sql`
      UPDATE credit_lots
      SET lifecycle = 'active', refund_attempts = refund_attempts + 1
      WHERE id = ${lotId}
    `;
    const lot = await readLot(lotId);
    expect(lot.remaining).toBe("70.000000");
    expect(lot.lifecycle).toBe("active");

    const outcome = await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 5,
      referenceId: `reject-charge-${Date.now()}`,
    });

    expect(outcome.charged).toBe(0);
    expect(outcome.shortfall).toBe(5);
    expect(await creditLotService.getStudioDebt(fx.studioId)).toBe(5);
  });

  it("欠账中 + 又扣不满 → 累加", async () => {
    const fx = await seedFixture();
    await seedLot(fx, 30, fx.studioId);
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 350,
      referenceId: `first-${Date.now()}`,
    });

    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 80,
      referenceId: `second-${Date.now()}`,
    });

    expect(await creditLotService.getStudioDebt(fx.studioId)).toBe(400);
  });

  it("欠账中 + 指定进来抵不完 → 这笔归零，仍欠着", async () => {
    const fx = await seedFixture();
    await seedLot(fx, 30, fx.studioId);
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 350,
      referenceId: `owe-${Date.now()}`,
    });
    const fresh = await seedLot(fx, 200);

    await creditLotService.designateLot({
      lotId: fresh,
      requestingUserId: fx.userId,
      studioId: fx.studioId,
    });

    const lot = await readLot(fresh);
    expect(lot.remaining).toBe("0.000000");
    expect(lot.lifecycle).toBe("depleted");
    expect(await creditLotService.getStudioDebt(fx.studioId)).toBe(120);
  });

  it("欠账中 + 指定进来抵完有剩 → 债清零，余下的能花", async () => {
    const fx = await seedFixture();
    await seedLot(fx, 30, fx.studioId);
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 350,
      referenceId: `owe2-${Date.now()}`,
    });
    const fresh = await seedLot(fx, 500);

    await creditLotService.designateLot({
      lotId: fresh,
      requestingUserId: fx.userId,
      studioId: fx.studioId,
    });

    const lot = await readLot(fresh);
    expect(lot.remaining).toBe("180.000000");
    expect(lot.lifecycle).toBe("active");
    expect(await creditLotService.getStudioDebt(fx.studioId)).toBe(0);
  });

  it("欠账中 + 把一笔撤走 → 欠的还是那么多", async () => {
    // 撤走既不产生也不消除债务。可用额更少了，欠的没变。
    const fx = await seedFixture();
    await seedLot(fx, 30, fx.studioId);
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 350,
      referenceId: `owe3-${Date.now()}`,
    });
    const fresh = await seedLot(fx, 500);
    await creditLotService.designateLot({
      lotId: fresh,
      requestingUserId: fx.userId,
      studioId: fx.studioId,
    });
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 1000,
      referenceId: `owe4-${Date.now()}`,
    });
    const owedBefore = await creditLotService.getStudioDebt(fx.studioId);

    const another = await seedLot(fx, 10);
    await creditLotService.designateLot({
      lotId: another,
      requestingUserId: fx.userId,
      studioId: fx.studioId,
    });
    await creditLotService.designateLot({
      lotId: another,
      requestingUserId: fx.userId,
      studioId: null,
    });

    expect(await creditLotService.getStudioDebt(fx.studioId)).toBe(
      owedBefore - 10,
    );
  });

  // The "owing" row of the transition table has no testable refund cells. A
  // studio that owes has no lot with a balance left (invariant 2), and a lot
  // drained to zero is refused a refund outright (§6.1: there is nothing
  // unspent to return). Any assertion written there holds before the refund as
  // well as after it. The cell that carries the counterexample the refund rule
  // closes — a rejected refund handing a lot back to a studio — lives on the
  // "no debt" row below, where the lot still has a balance and losing its
  // designation is the only thing that can empty the pool.

  it("欠账中扣费一分也扣不到 —— 「全额扣到」那一格进不去", async () => {
    // 转移表里那格写着「不可能」，凭据是不变量 2：欠账意味着上一次把这个
    // studio 的笔扣空了，而让笔重新有余额只有指定这一条路，它第一件事就是
    // 抵债。所以欠账期间可花的笔加起来必然是 0。
    const fx = await seedFixture();
    await seedLot(fx, 30, fx.studioId);
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 350,
      referenceId: `imposs-${Date.now()}`,
    });

    expect(
      Number(await creditLotRepo.sumSpendableForStudio(fx.studioId)),
    ).toBe(0);
    const outcome = await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 5,
      referenceId: `imposs2-${Date.now()}`,
    });
    expect(outcome.charged).toBe(0);
    expect(outcome.shortfall).toBe(5);
  });
});

describe("欠账：不变量", () => {
  it("不变量 3：欠账恒等于两类流水之差", async () => {
    // 两类行金额都是负数，所以是 repayment 减 incurred：欠 320 时
    // 0 - (-320) = 320；抵掉 150 之后 -150 - (-320) = 170。
    const fx = await seedFixture();
    await seedLot(fx, 30, fx.studioId);
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 350,
      referenceId: `inv3-${Date.now()}`,
    });

    const afterCharge = await debtLedgerSums(fx.studioId);
    expect(
      Number(afterCharge.repayment) - Number(afterCharge.incurred),
    ).toBe(await creditLotService.getStudioDebt(fx.studioId));

    const fresh = await seedLot(fx, 150);
    await creditLotService.designateLot({
      lotId: fresh,
      requestingUserId: fx.userId,
      studioId: fx.studioId,
    });

    const afterRepay = await debtLedgerSums(fx.studioId);
    expect(Number(afterRepay.repayment) - Number(afterRepay.incurred)).toBe(
      await creditLotService.getStudioDebt(fx.studioId),
    );
    expect(await creditLotService.getStudioDebt(fx.studioId)).toBe(170);
  });

  it("不变量 4：同一次生成的流水行加起来等于这次消耗的全额", async () => {
    // 扣到的加上欠下的，正好是账单。`tasks.billed_credits` 写全额因此重新
    // 成立 —— 流水现在也记满了这个量。
    const fx = await seedFixture();
    await seedLot(fx, 30, fx.studioId);
    const reference = `inv4-${Date.now()}`;

    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 350,
      referenceId: reference,
    });

    const [row] = await sql<{ total: string }[]>`
      SELECT COALESCE(SUM(amount), 0)::text AS total
      FROM credit_ledger WHERE reference_id = ${reference}
    `;
    expect(Number(row!.total)).toBe(-350);
  });

  it("扣不满写下的那一行带着界面要的全套上下文", async () => {
    // 一笔都扣不到时一行 spend 都没有，那次生成的 Project 与模型只能从这一行
    // 取。缺了它，积分页那一行的中间两列就是空的。
    const fx = await seedFixture();
    const reference = `ctx-${Date.now()}`;

    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 42,
      referenceId: reference,
      model: "seedance-1.5-pro",
      provider: "volcengine",
    });

    const [row] = await sql<
      {
        studio_id: string | null;
        project_id: string | null;
        model: string | null;
        provider: string | null;
        actor_user_id: string | null;
        payer_user_id: string | null;
        lot_id: string | null;
        amount: string;
      }[]
    >`
      SELECT studio_id, project_id, model, provider, actor_user_id,
             payer_user_id, lot_id, amount
      FROM credit_ledger
      WHERE reference_id = ${reference} AND entry_type = 'debt_incurred'
    `;
    expect(row).toBeDefined();
    expect(row!.studio_id).toBe(fx.studioId);
    expect(row!.project_id).toBe(fx.projectId);
    expect(row!.model).toBe("seedance-1.5-pro");
    expect(row!.provider).toBe("volcengine");
    expect(row!.actor_user_id).toBe(fx.userId);
    // Nobody has paid this. The studio owes it, and whoever assigns a
    // purchase there pays it off — that repayment is the row naming them.
    expect(row!.payer_user_id).toBeNull();
    expect(row!.lot_id).toBeNull();
    expect(row!.amount).toBe("-42.000000");
  });
});

describe("studio 流水：一次生成一行", () => {
  it("跨笔摊扣在界面上是一行，金额是实扣", async () => {
    // 库里按笔记多行，那是对账的依据。用户要看的是「这次生成花了多少」，
    // 摊扣的细节不出现在界面上。
    const fx = await seedFixture();
    await seedLot(fx, 40, fx.studioId);
    await seedLot(fx, 40, fx.studioId);
    const reference = `agg-${Date.now()}`;

    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 70,
      referenceId: reference,
      model: "seedance-1.5-pro",
    });

    const rows = await creditLotRepo.listLedgerByStudio(fx.studioId, 10, null);
    expect(rows.filter((r) => r.kind === "generation")).toEqual([
      expect.objectContaining({
        charged: "-70.000000",
        consumed: "-70.000000",
        owed: "0",
        projectId: fx.projectId,
        projectName: fx.projectName,
        model: "seedance-1.5-pro",
      }),
    ]);
  });

  it("扣不满的生成：实扣、消耗、欠额三个数各是各的", async () => {
    const fx = await seedFixture();
    await seedLot(fx, 30, fx.studioId);
    const reference = `agg-short-${Date.now()}`;

    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 350,
      referenceId: reference,
      model: "seedance-1.5-pro",
    });

    const rows = await creditLotRepo.listLedgerByStudio(fx.studioId, 10, null);
    const generation = rows.find((r) => r.kind === "generation");
    expect(generation).toMatchObject({
      charged: "-30.000000",
      consumed: "-350.000000",
      owed: "-320.000000",
    });
  });

  it("没扣费的生成：消耗有数，实扣是零", async () => {
    // 一分都扣不到时写下的行 lot_id 为空，所以它不算实扣 —— 界面上金额
    // 显示 0，下面标「消耗多少，未扣费」。
    const fx = await seedFixture();
    const reference = `agg-free-${Date.now()}`;

    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 42.5,
      referenceId: reference,
    });

    const rows = await creditLotRepo.listLedgerByStudio(fx.studioId, 10, null);
    const generation = rows.find((r) => r.kind === "generation");
    expect(generation).toMatchObject({
      charged: "0",
      consumed: "-42.500000",
      owed: "-42.500000",
    });
  });

  it("抵扣欠账自成一行，没有 project 也没有模型", async () => {
    // 它不发生在任何 project 里，也不用任何模型。界面上那两列合并写事件。
    const fx = await seedFixture();
    await seedLot(fx, 30, fx.studioId);
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 350,
      referenceId: `agg-owe-${Date.now()}`,
    });
    const fresh = await seedLot(fx, 150);
    await creditLotService.designateLot({
      lotId: fresh,
      requestingUserId: fx.userId,
      studioId: fx.studioId,
    });

    const rows = await creditLotRepo.listLedgerByStudio(fx.studioId, 10, null);
    const repayment = rows.filter((r) => r.kind === "debt_repayment");
    expect(repayment).toEqual([
      expect.objectContaining({
        charged: "-150.000000",
        consumed: "0",
        owed: "0",
        projectId: null,
        model: null,
      }),
    ]);
  });

  it("按 studio 取，不按谁付的钱切", async () => {
    // 一次扣不满的生成，spend 行的付款方是笔的主人，debt_incurred 行的
    // 付款方是操作人。按付款方过滤会把同一次生成劈到两个人的视图里，谁都
    // 拼不出完整的一行。
    const fx = await seedFixture();
    const other = await seedFixture();
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role)
      VALUES (${fx.studioId}, ${other.userId}, 'maintainer')
    `;
    await seedLot(fx, 30, fx.studioId);

    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: other.userId,
      amount: 350,
      referenceId: `agg-two-${Date.now()}`,
    });

    const rows = await creditLotRepo.listLedgerByStudio(fx.studioId, 10, null);
    const generation = rows.find((r) => r.kind === "generation");
    expect(generation).toMatchObject({
      charged: "-30.000000",
      consumed: "-350.000000",
      actorUserId: other.userId,
    });
  });

  it("翻页时一次生成不会被切成两页", async () => {
    // 一次生成的多行 created_at 几乎相同、id 不同。聚合排在分页之后，取一页
    // 就会切在中间，那次生成被劈开、两页各显示一个残数。
    const fx = await seedFixture();
    await seedLot(fx, 40, fx.studioId);
    await seedLot(fx, 40, fx.studioId);
    for (const n of [1, 2]) {
      await creditLotService.chargeForGeneration({
        projectId: fx.projectId,
        actorUserId: fx.userId,
        amount: 35,
        referenceId: `agg-page-${n}-${Date.now()}`,
      });
    }

    const first = await creditLotRepo.listLedgerByStudio(fx.studioId, 1, null);
    expect(first).toHaveLength(1);
    expect(first[0]!.charged).toBe("-35.000000");

    const second = await creditLotRepo.listLedgerByStudio(fx.studioId, 1, {
      createdAt: first[0]!.cursorAt,
      id: first[0]!.id,
    });
    expect(second).toHaveLength(1);
    expect(second[0]!.charged).toBe("-35.000000");
    expect(second[0]!.id).not.toBe(first[0]!.id);
  });

  it("walks every row of the account ledger across the same boundary", async () => {
    // The account ledger pages through the same cursor, so it is the second
    // consumer of that fix rather than a second fix.
    const fx = await seedFixture();
    const stamps = [
      "2026-08-23 10:00:00.223900+00",
      "2026-08-23 10:00:00.223400+00",
      "2026-08-23 10:00:00.223000+00",
    ];
    // Rows that drew on a purchase: the account ledger reports what left
    // this account's purchases, so a row with no lot behind it is not one of
    // its rows and would not exercise its paging.
    const lotId = await seedLot(fx, 100, fx.studioId);
    for (let i = 0; i < stamps.length; i++) {
      await sql.unsafe(`
        INSERT INTO credit_ledger
          (payer_user_id, actor_user_id, entry_type, studio_id, project_id,
           amount, lot_id, reference_id, created_at)
        VALUES ('${fx.userId}', '${fx.userId}', 'spend', '${fx.studioId}',
                '${fx.projectId}', -10, '${lotId}', 'payer-ms-${i}',
                TIMESTAMPTZ '${stamps[i]!}')`);
    }

    const seen: string[] = [];
    let cursor: ActivityCursor | null = null;
    for (let page = 0; page < 5; page++) {
      const rows = await creditLotRepo.listLedgerByPayer(fx.userId, 1, cursor);
      if (rows.length === 0) break;
      seen.push(rows[0]!.id);
      cursor = { createdAt: rows[0]!.cursorAt, id: rows[0]!.id };
    }

    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
  });

  it("walks every row when a page boundary falls inside one millisecond", async () => {
    // `created_at` is written by `now()` and Postgres keeps it to the
    // microsecond, so two generations a few hundred microseconds apart share a
    // millisecond. A cursor that carries only milliseconds draws the "continue
    // from here" line in the wrong place and the rows inside that gap are
    // never returned again.
    const fx = await seedFixture();
    const stamps = [
      "2026-08-22 10:00:00.123900+00",
      "2026-08-22 10:00:00.123400+00",
      "2026-08-22 10:00:00.123000+00",
    ];
    for (let i = 0; i < stamps.length; i++) {
      // A literal, because a parameterised timestamp goes through the driver
      // and loses the microseconds on the way in.
      await sql.unsafe(`
        INSERT INTO credit_ledger
          (payer_user_id, actor_user_id, entry_type, studio_id, project_id,
           amount, lot_id, reference_id, created_at)
        VALUES ('${fx.userId}', '${fx.userId}', 'spend', '${fx.studioId}',
                '${fx.projectId}', -10, NULL, 'same-ms-${i}',
                TIMESTAMPTZ '${stamps[i]!}')`);
    }

    const seen: string[] = [];
    let cursor: ActivityCursor | null = null;
    for (let page = 0; page < 5; page++) {
      const rows = await creditLotRepo.listLedgerByStudio(fx.studioId, 1, cursor);
      if (rows.length === 0) break;
      seen.push(rows[0]!.id);
      cursor = { createdAt: rows[0]!.cursorAt, id: rows[0]!.id };
    }

    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
  });

  it("walks every lot when a page boundary falls inside one millisecond", async () => {
    // Same reason as the ledger above, on the other list that pages by time:
    // a person who buys three packs in one go has three lots inside one
    // millisecond, and a cursor rounded to milliseconds skips the ones behind
    // the boundary.
    const fx = await seedFixture();
    const stamps = [
      "2026-08-22 11:00:00.456900+00",
      "2026-08-22 11:00:00.456400+00",
      "2026-08-22 11:00:00.456000+00",
    ];
    for (const stamp of stamps) {
      const lotId = await seedLot(fx, 10, fx.studioId);
      // A literal, because a parameterised timestamp goes through the driver
      // and loses the microseconds on the way in.
      await sql.unsafe(
        `UPDATE credit_lots SET created_at = TIMESTAMPTZ '${stamp}' WHERE id = '${lotId}'`,
      );
    }

    const seen: string[] = [];
    let cursor: ActivityCursor | null = null;
    for (let page = 0; page < 5; page++) {
      const rows = await creditLotRepo.listLotsByUser(fx.userId, 1, cursor);
      if (rows.length === 0) break;
      seen.push(rows[0]!.id);
      cursor = { createdAt: rows[0]!.cursorAt, id: rows[0]!.id };
    }

    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
  });

  it("游标带的 id 是 uuid，读侧的校验过得去", async () => {
    // 分组键是 reference_id，可能是 `texttool:xxx` 这种不是 uuid 的东西。
    // 游标里放它会被读侧判为无效、回落到第一页，滚到底就无限重复第一页。
    const fx = await seedFixture();
    await seedLot(fx, 100, fx.studioId);
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 10,
      referenceId: `texttool:not-a-uuid-${Date.now()}`,
    });

    const rows = await creditLotRepo.listLedgerByStudio(fx.studioId, 10, null);
    const generation = rows.find((r) => r.kind === "generation");
    expect(generation!.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});

describe("欠账：任意序列下的两条不变量", () => {
  it("欠着账时可花的笔加起来恒为 0，欠账恒等于两类流水之差", async () => {
    // 不变量 2 和 3，跑在随机的充值、指定、扣费序列上。前者是转移表那格
    // 「不可能」的凭据 —— 它一旦破了，欠账中的 studio 就能扣到钱，而那格
    // 从没有人为它写过代码。
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc
              .integer({ min: 1, max: 200 })
              .map((credits) => ({ kind: "assign" as const, credits })),
            fc
              .integer({ min: 1, max: 300 })
              .map((amount) => ({ kind: "charge" as const, amount })),
          ),
          { minLength: 1, maxLength: 8 },
        ),
        async (steps) => {
          const fx = await seedFixture();
          for (const [i, step] of steps.entries()) {
            if (step.kind === "assign") {
              const lotId = await seedLot(fx, step.credits);
              await creditLotService.designateLot({
                lotId,
                requestingUserId: fx.userId,
                studioId: fx.studioId,
              });
            } else {
              await creditLotService.chargeForGeneration({
                projectId: fx.projectId,
                actorUserId: fx.userId,
                amount: step.amount,
                referenceId: `prop-${fx.studioId}-${i}`,
              });
            }

            const debt = await creditLotService.getStudioDebt(fx.studioId);
            const spendable = Number(
              await creditLotRepo.sumSpendableForStudio(fx.studioId),
            );
            if (debt > 0) expect(spendable).toBe(0);

            const sums = await debtLedgerSums(fx.studioId);
            expect(Number(sums.repayment) - Number(sums.incurred)).toBe(debt);
          }
        },
      ),
      { numRuns: 12 },
    );
  });
});

describe("欠账：并发", () => {
  it("两次扣费同时欠账，两笔差额都记上", async () => {
    const fx = await seedFixture();
    const open = await holdDebtLock(fx.studioId);

    const first = creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 40,
      referenceId: `con-a-${Date.now()}`,
    });
    await waitUntilBlockedOn(sql, ["studio_credit_debts", "for update"], 1);
    const second = creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 60,
      referenceId: `con-b-${Date.now()}`,
    });
    await waitUntilBlockedOn(sql, ["studio_credit_debts", "for update"], 2);

    await open();
    await Promise.all([first, second]);

    expect(await creditLotService.getStudioDebt(fx.studioId)).toBe(100);
  });

  it("首次欠账的两个并发都要成功，一条都不能丢", async () => {
    // 上一条测的是债行已经在了、两边争 FOR UPDATE。这一条测的是它还不存在：
    // 两边同时走 `INSERT ... ON CONFLICT DO NOTHING`，先到的那个建行，后到的
    // 认输之后照样要拿到锁。闸门因此不能预先把行插好 —— 那样两边都走不到
    // 唯一索引这一关，而这一关正是要测的。
    const fx = await seedFixture();
    const rows = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM studio_credit_debts WHERE studio_id = ${fx.studioId}
      ) AS exists`;
    expect(rows[0]!.exists).toBe(false);

    const open = await holdDebtRowInsert(fx.studioId);

    const first = creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 40,
      referenceId: `first-a-${Date.now()}`,
    });
    await waitUntilBlockedOn(sql, ["studio_credit_debts", "on conflict"], 1);
    const second = creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 60,
      referenceId: `first-b-${Date.now()}`,
    });
    await waitUntilBlockedOn(sql, ["studio_credit_debts", "on conflict"], 2);

    await open();
    const outcomes = await Promise.all([first, second]);

    expect(outcomes.map((o) => o.shortfall).sort((a, b) => a - b)).toEqual([
      40, 60,
    ]);
    expect(await creditLotService.getStudioDebt(fx.studioId)).toBe(100);
  });

  it("一次扣费撞一次指定，两者排队而不是各持一半", async () => {
    // 两条写路径都先拿欠账行、再拿笔。顺序一致，所以后到的那个等在第一把
    // 锁上，不会握着笔去等欠账行。
    const fx = await seedFixture();
    await seedLot(fx, 30, fx.studioId);
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 350,
      referenceId: `con-owe-${Date.now()}`,
    });
    const fresh = await seedLot(fx, 500);
    const open = await holdDebtLock(fx.studioId);

    const designating = creditLotService.designateLot({
      lotId: fresh,
      requestingUserId: fx.userId,
      studioId: fx.studioId,
    });
    await waitUntilBlockedOn(sql, ["studio_credit_debts", "for update"], 1);
    const charging = creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 100,
      referenceId: `con-charge-${Date.now()}`,
    });
    await waitUntilBlockedOn(sql, ["studio_credit_debts", "for update"], 2);

    await open();
    await designating;
    await charging;

    // 先抵掉 320 的债，剩 180 能花；那次扣费拿走 100，剩 80，无欠账。
    expect(await creditLotService.getStudioDebt(fx.studioId)).toBe(0);
    expect(Number(await creditLotRepo.sumSpendableForStudio(fx.studioId))).toBe(
      80,
    );
  });
});
