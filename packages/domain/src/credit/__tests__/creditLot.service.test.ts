// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 扣费开头解析 studio 失败时，两种错因的处置完全相反（任务 #11）。
 *
 * project 真的没了：产物已经交付，用量照记，账记在没有笔的那一侧。
 * 查询本身失败：什么都不知道，这时记一行「没扣到」等于把一次未知的失败
 * 写成一条确定的账，而调用方会当作正常结果继续往下走、把差额写进日志。
 *
 * 这条分岔在 `db.transaction` 之前就发生了，所以这里只替换解析 studio 和
 * 写流水两处，事务那一层一次都碰不到。放在 domain 包内是因为被测函数用
 * `@domain/*` 引用它的依赖，只有这个包的 vitest 别名拦得住；server 的集成
 * 测试从 `dist` 解析这个包，那是打平的产物，内部引用没有替换的余地。
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { initCore, NotFoundError } from "@breatic/core";

const resolveOwnerStudioId = vi.fn<(projectId: string) => Promise<string>>();
const appendLedgerEntry = vi.fn(async (..._args: unknown[]) => undefined);

vi.mock("@domain/asset/asset.service.js", () => ({
  resolveOwnerStudioId: (projectId: string) => resolveOwnerStudioId(projectId),
}));

vi.mock("@domain/credit/creditLot.repo.js", () => ({
  appendLedgerEntry: (...args: unknown[]) => appendLedgerEntry(...args),
  listSpendableLots: async () => [],
  lockLot: async () => null,
  applyCharge: async () => undefined,
}));

beforeAll(() => {
  initCore({
    ...process.env,
    PAYMENT_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_unused",
    STRIPE_WEBHOOK_SECRET: "whsec_unused",
  });
});

beforeEach(() => {
  resolveOwnerStudioId.mockReset();
  appendLedgerEntry.mockClear();
});

/** 每个用例各自 import，让上面的替身在模块求值时就位。 */
async function charge(): Promise<unknown> {
  const { chargeForGeneration } = await import("@domain/credit/creditLot.service.js");
  return chargeForGeneration({
    projectId: "11111111-1111-4111-8111-111111111111",
    actorUserId: "22222222-2222-4222-8222-222222222222",
    amount: 10,
  });
}

describe("project 真的没了", () => {
  it("用量照记，账记在没有笔的那一侧", async () => {
    resolveOwnerStudioId.mockRejectedValueOnce(new NotFoundError("gone"));

    await expect(charge()).resolves.toMatchObject({
      billed: false,
      charged: 0,
      shortfall: 10,
      studioId: null,
    });
    expect(appendLedgerEntry).toHaveBeenCalledTimes(1);
  });
});

describe("解析 studio 的查询本身失败", () => {
  it("抛出来，不当成「project 没了」", async () => {
    resolveOwnerStudioId.mockRejectedValueOnce(
      new Error("connection terminated unexpectedly"),
    );

    await expect(charge()).rejects.toThrow("connection terminated unexpectedly");
  });

  it("不写任何流水行", async () => {
    resolveOwnerStudioId.mockRejectedValueOnce(new Error("pool exhausted"));

    await charge().catch(() => undefined);

    expect(appendLedgerEntry).not.toHaveBeenCalled();
  });
});
