// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Payment-disabled deployments record usage without drawing from credit lots.
 * The process-wide payment setting needs a separate suite from billed cases.
 * Unbilled ledger entries retain the payer and actor while their lot stays null.
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
import { creditViewService } from "@server/modules/index.js";

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
  // Both production paths that create a studio write this row, and the
  // account-side reads ask it who administers the studio.
  // `created_by_user_id` records who opened it and never changes, so it
  // cannot answer that.
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studioId}, ${userId}, 'admin')
  `;
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
    expect(outcome).toMatchObject({ billed: false, charged: "0.000000", shortfall: "0.000000" });

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

describe("the account ledger on a deployment that charges nobody", () => {
  it("lists the usage, marked as having drawn on no purchase", async () => {
    // 这个部署里每一行用量的 lot_id 都是空的。验收项 13 说消耗流水照常
    // 显示，而这一项的脚注也已经对用户说了「下面是用量记录」。
    const fx = await seedFixture();
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 42,
      model: "seedream-4.0",
      referenceId: `off-ledger-${Date.now()}`,
    });

    const page = await creditViewService.listLedger(fx.userId);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      kind: "unbilled",
      amount: "-42.000000",
      model: "seedream-4.0",
      studioId: fx.studioId,
    });
  });
});

describe("支付关闭时的已消耗（任务 #12，计划 §4.6）", () => {
  it("无包可扣的用量算进这个 studio 的已消耗", async () => {
    const fx = await seedFixture();
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 42,
      model: "seedream-4.0",
    });

    const overview = await creditLotService.getOverview(fx.userId);
    const mine = overview.studios.find((s) => s.studioId === fx.studioId);

    // Unbilled spend still counts as Studio consumption without a credit lot;
    // debt_incurred records the liability and is excluded from consumption.
    expect(mine).toBeDefined();
    expect(mine!.spent).toBe("42.000000");
  });
});
