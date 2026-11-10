// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * 扣费开头解析 studio 失败时，两种错因的处置完全相反（任务 #11）。
 *
 * project 真的没了：产物已经交付，用量照记，账记在没有笔的那一侧。
 * 查询本身失败：什么都不知道，这时记一行「没扣到」等于把一次未知的失败
 * 写成一条确定的账，而调用方会当作正常结果继续往下走、把差额写进日志。
 *
 * Since inner#1617 the studio is resolved inside the settle transaction,
 * after the charge request row is locked: a failed query rolls the settle
 * back and leaves the request pending for the sweep, and a vanished project
 * settles the request with its usage recorded. The transaction and the
 * charge-request repository are stand-ins here (repository names as assumed
 * in `charge-signal.test.ts`). 放在 domain 包内是因为被测函数用
 * `@domain/*` 引用它的依赖，只有这个包的 vitest 别名拦得住；server 的集成
 * 测试从 `dist` 解析这个包，那是打平的产物，内部引用没有替换的余地。
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import type * as CoreModule from "@breatic/core";
import { initCore, NotFoundError } from "@breatic/core";

const resolveOwnerStudioId = vi.fn<(projectId: string) => Promise<string>>();
const appendLedgerEntry = vi.fn(async (..._args: unknown[]) => undefined);
const recordStandaloneUsage = vi.fn(async (..._args: unknown[]) => undefined);
const markSettled = vi.fn(async (..._args: unknown[]) => undefined);
const committed = { value: false };

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    db: {
      transaction: async (run: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
        const result = await run({});
        committed.value = true;
        return result;
      },
    },
    publishCreditsChanged: async () => undefined,
  };
});

vi.mock("@domain/credit/creditHold.repo.js", () => ({
  releaseHold: async () => undefined,
}));

vi.mock("@domain/credit/creditCharge.repo.js", () => ({
  lockById: async (id: string) => ({
    id,
    kind: "task",
    actorUserId: "22222222-2222-4222-8222-222222222222",
    referenceId: "task-1",
    projectId: "11111111-1111-4111-8111-111111111111",
    amount: "10.000000",
    description: null,
    model: null,
    provider: null,
    tokensUsed: null,
    releaseHold: null,
    status: "pending",
  }),
  markSettled: (...args: unknown[]) => markSettled(...args),
  insertPending: async () => null,
  recordFailure: async () => undefined,
}));

vi.mock("@domain/asset/asset.service.js", () => ({
  resolveOwnerStudioId: (projectId: string) => resolveOwnerStudioId(projectId),
}));

vi.mock("@domain/credit/creditLot.repo.js", () => ({
  appendLedgerEntry: (...args: unknown[]) => appendLedgerEntry(...args),
  recordStandaloneUsage: (...args: unknown[]) => recordStandaloneUsage(...args),
  lockDebt: async () => "0",
  adjustDebt: async () => undefined,
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
  recordStandaloneUsage.mockClear();
  markSettled.mockClear();
  committed.value = false;
});

/** 每个用例各自 import，让上面的替身在模块求值时就位。 */
async function charge(): Promise<unknown> {
  const { settleCharge } = await import("@domain/credit/creditLot.service.js");
  return settleCharge("req-1");
}

describe("project 真的没了", () => {
  it("用量照记，账记在没有笔的那一侧", async () => {
    resolveOwnerStudioId.mockRejectedValueOnce(new NotFoundError("gone"));

    await expect(charge()).resolves.toMatchObject({
      billed: false,
      charged: "0.000000",
      shortfall: "10.000000",
      studioId: null,
    });
    // The standalone exit, which is the one that carries no lot: this row
    // keeps no balance in step, so it is whole on its own.
    expect(recordStandaloneUsage).toHaveBeenCalledTimes(1);
    expect(appendLedgerEntry).not.toHaveBeenCalled();
    // Recorded is settled: the request leaves the sweep in the same commit.
    expect(markSettled).toHaveBeenCalledTimes(1);
    expect(markSettled.mock.calls[0]?.[0]).toBe("req-1");
    expect(committed.value).toBe(true);
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
    expect(recordStandaloneUsage).not.toHaveBeenCalled();
  });

  it("leaves the request pending for the sweep", async () => {
    resolveOwnerStudioId.mockRejectedValueOnce(new Error("pool exhausted"));

    await charge().catch(() => undefined);

    expect(markSettled).not.toHaveBeenCalled();
    expect(committed.value).toBe(false);
  });
});
