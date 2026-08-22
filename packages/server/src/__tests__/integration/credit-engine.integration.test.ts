// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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

import postgres from "postgres";
import { initCore, env, loadLocales } from "@breatic/core";
import { creditLotService, creditLotRepo } from "@breatic/domain";
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
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, slug, name)
    VALUES (${studioId}, ${userId}, ${`engine-p-${n}-${Date.now()}`}, 'Engine') RETURNING id
  `;
  return { userId, studioId, projectId: project!.id };
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

  it("取笔这一层自己就滤掉退款流程里的笔", async () => {
    // 锁到之后还会复核一次 lifecycle，所以这两道各自都能拦住。要让它们
    // 各有一个只属于自己的观察点，这一条必须直接问取笔那一层。
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 500, fx.studioId);
    await sql`UPDATE credit_lots SET lifecycle = 'refund_pending' WHERE id = ${lotId}`;

    expect(await creditLotRepo.listSpendableLots(fx.studioId)).toEqual([]);
  });

  it("不取退款流程里的笔", async () => {
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 500, fx.studioId);
    await sql`UPDATE credit_lots SET lifecycle = 'refund_pending' WHERE id = ${lotId}`;

    const outcome = await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 10,
    });

    expect(outcome.charged).toBe(0);
    expect((await readLot(lotId)).remaining).toBe("500.000000");
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
  it("「花了多少」只算真扣到笔的那些，不算记了用量但一分没扣的", async () => {
    // 三条不扣费的路径写的都是 entry_type='spend'，区别只在 lot_id 为空。
    // 少了这个条件，面板会报出从未离开账户的钱。
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

  it("「由哪几笔构成」不列已经花光的笔", async () => {
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 100, fx.studioId);
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 100,
    });

    expect((await readLot(lotId)).lifecycle).toBe("depleted");
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
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 100, fx.studioId);
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
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 100, fx.studioId);
    const open = await holdLotLock(lotId);

    // 两次都要 60，而这一笔只有 100。谁也不许读到没被对方扣过的余额。
    const first = creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 60,
    });
    await waitUntilBlockedOn(sql, ["credit_lots", "for update"], 1);
    const second = creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 60,
    });
    await waitUntilBlockedOn(sql, ["credit_lots", "for update"], 2);

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

  it("一笔在被选中和被锁住之间进了退款流程，就扣不到它了", async () => {
    // 跟上一条同一个道理，换成 lifecycle 那一列：这笔正在离开这个账号，
    // 锁到之后必须重读，否则退款金额算的是一个已经被人花过的剩余。
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 100, fx.studioId);
    const gate = postgres(inject("DATABASE_URL"), {
      max: 1,
      prepare: false,
      connection: { application_name: `${PG_DRIVER_LOCAL}-gate2` },
    });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired: () => void = () => {};
    const lockHeld = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const done = gate.begin(async (tx) => {
      await tx`SELECT id FROM credit_lots WHERE id = ${lotId} FOR UPDATE`;
      acquired();
      await held;
      await tx`UPDATE credit_lots SET lifecycle = 'refund_pending' WHERE id = ${lotId}`;
    });
    await lockHeld;

    const charging = creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 40,
    });
    await waitUntilBlockedOn(sql, ["credit_lots", "for update"], 1);

    release();
    await done;
    await gate.end({ timeout: 1 });
    const outcome = await charging;

    expect(outcome.charged).toBe(0);
    expect(await readLot(lotId)).toMatchObject({ remaining: "100.000000" });
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

    expect(await creditLotRepo.sumSpendableForStudio(fx.studioId)).toBe(
      "0.000000",
    );
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
        payer_user_id: string;
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
    expect(row!.payer_user_id).toBe(fx.userId);
    expect(row!.lot_id).toBeNull();
    expect(row!.amount).toBe("-42.000000");
  });
});
