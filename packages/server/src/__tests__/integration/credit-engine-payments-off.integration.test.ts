// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 支付关闭时的积分引擎（任务 #11）。
 *
 * **这是今天唯一在跑的那条路径**：每个开发环境、每个自部署实例都是支付关闭。
 * 它单独一个文件，因为开关是进程级的，跟旁边那个套件不能共存于同一个文件。
 *
 * 关掉支付之后余额是派生出来的、恒为零，加上「未指定不能花」，任何生成都会
 * 取不到笔。所以哨兵必须放在派生查询之外：预检直接放行、扣费什么都不动，
 * 但**用量记录照写** —— 不扣费的部署同样要知道自己产出了什么。
 *
 * 这让 `credit_ledger.lot_id` 必须可空：这一行没有对应的笔。`payer_user_id`
 * 不跟着可空 —— 账号流水恒按付款方取，这些行必须出现在里面。
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
import { initCore, env } from "@breatic/core";
import { creditLotService } from "@breatic/domain";

const PG_DRIVER_LOCAL = "credit-engine-off-test-driver";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  // 显式关掉，而不是指望进程环境恰好是关的 —— 同一个 worker 里的别的套件
  // 会为了自己的需要把它打开。
  initCore({ ...process.env, PAYMENT_ENABLED: "false" });
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: PG_DRIVER_LOCAL },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  initCore(process.env);
});

let seq = 0;

/** 一个用户 + 他的 studio + 一个 project。 */
async function seedFixture(): Promise<{
  userId: string;
  studioId: string;
  projectId: string;
}> {
  const n = seq++;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`off-${n}-${Date.now()}@example.test`}, true) RETURNING id
  `;
  const userId = user!.id;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`off-s-${n}-${Date.now()}`}, 'team', 'Off') RETURNING id
  `;
  const studioId = studio!.id;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, slug, name)
    VALUES (${studioId}, ${userId}, ${`off-p-${n}-${Date.now()}`}, 'Off') RETURNING id
  `;
  return { userId, studioId, projectId: project!.id };
}

describe("支付关闭", () => {
  it("开关确实是关的", () => {
    expect(env.PAYMENT_ENABLED).toBe(false);
  });

  it("照写用量记录，lot_id 为空而付款方照填", async () => {
    const fx = await seedFixture();

    const outcome = await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 42.5,
      model: "seedance-1.5-pro",
      provider: "volcengine",
      referenceId: `off-task-${Date.now()}`,
    });

    // 不扣费，也不是「扣不出来」：这个部署本来就不收费。
    expect(outcome).toMatchObject({ billed: false, charged: 0, shortfall: 0 });

    const [row] = await sql<
      {
        lot_id: string | null;
        payer_user_id: string;
        studio_id: string | null;
        amount: string;
        model: string | null;
      }[]
    >`
      SELECT lot_id, payer_user_id, studio_id, amount, model
      FROM credit_ledger
      WHERE payer_user_id = ${fx.userId} AND entry_type = 'spend'
    `;
    expect(row?.lot_id).toBeNull();
    // 账号流水恒按付款方取，所以这一行必须带着人，否则自部署那边一条
    // 用量都看不见。
    expect(row?.payer_user_id).toBe(fx.userId);
    expect(row?.studio_id).toBe(fx.studioId);
    expect(row?.amount).toBe("-42.500000");
    expect(row?.model).toBe("seedance-1.5-pro");
  });

  it("一笔都没有也不报错、不失败", async () => {
    // 这正是每个开发环境的日常：库里一行 credit_lots 都没有。
    const fx = await seedFixture();
    await expect(
      creditLotService.chargeForGeneration({
        projectId: fx.projectId,
        actorUserId: fx.userId,
        amount: 1,
      }),
    ).resolves.toMatchObject({ billed: false });
  });
});
