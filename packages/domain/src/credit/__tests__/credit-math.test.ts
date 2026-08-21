// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 跨笔摊扣的纯逻辑（任务 #11）。
 *
 * 一次生成常常花不完一笔、也常常一笔不够花：包价是 880 到 45660 积分，
 * 而一次视频生成几十到上百积分且不取整。所以扣费不是在某一笔上做一次
 * 减法，是按「先充先花」把要扣的量摊到多笔上。这个文件测的就是「怎么摊」，
 * 不碰数据库。
 *
 * 定点数换算单独测，因为它是这层不出错的前提：积分是 numeric(20,6)，
 * 用二进制浮点做加减会在某一笔上留下花不掉也退不掉的零头。
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  toMicroCredits,
  fromMicroCredits,
  planCharge,
} from "@domain/credit/credit-math.js";

describe("定点数换算", () => {
  it("把数据库读回来的字符串按六位小数换成整数微积分", () => {
    expect(toMicroCredits("880.000000")).toBe(880_000_000);
    expect(toMicroCredits("0.000001")).toBe(1);
    expect(toMicroCredits("0")).toBe(0);
    expect(toMicroCredits("12.345678")).toBe(12_345_678);
  });

  it("接受小数位不足六位的写法", () => {
    // Postgres 按列的 scale 补零，但迁移、手写 SQL 和测试夹具都可能给短的。
    expect(toMicroCredits("1.5")).toBe(1_500_000);
    expect(toMicroCredits("1.")).toBe(1_000_000);
  });

  it("把调用方传的数字换过来，不引入浮点残差", () => {
    // 0.1 + 0.2 那类残差如果漏进来，一笔上会留下几微积分的零头，
    // 而它既花不掉也退不回去。
    expect(toMicroCredits(0.1 + 0.2)).toBe(300_000);
    expect(toMicroCredits(12.345678)).toBe(12_345_678);
  });

  it("拒绝不是十进制数的字符串，不静默变成 NaN", () => {
    // 这一列的宽度装得下这段代码表示不了的东西。一个静默的 NaN 会当成
    // 扣费金额一路传下去，最后落成一行谁也对不上的账。
    expect(() => toMicroCredits("abc")).toThrow(/decimal number/);
    expect(() => toMicroCredits("")).toThrow(/decimal number/);
    expect(() => toMicroCredits("1e5")).toThrow(/decimal number/);
    expect(() => toMicroCredits("1,5")).toThrow(/decimal number/);
    expect(() => toMicroCredits(Number.NaN)).toThrow(/finite number/);
    expect(() => toMicroCredits(Number.POSITIVE_INFINITY)).toThrow(/finite number/);
  });

  it("换回字符串时恒带六位小数，直接可以写进 numeric(20,6)", () => {
    expect(fromMicroCredits(880_000_000)).toBe("880.000000");
    expect(fromMicroCredits(1)).toBe("0.000001");
    expect(fromMicroCredits(0)).toBe("0.000000");
  });

  it("来回换算不丢值", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10 ** 13 }), (micro) => {
        expect(toMicroCredits(fromMicroCredits(micro))).toBe(micro);
      }),
    );
  });
});

describe("planCharge", () => {
  const lot = (id: string, remaining: number): { id: string; remaining: number } => ({
    id,
    remaining,
  });

  it("一笔够花时只动第一笔", () => {
    const plan = planCharge([lot("a", 100), lot("b", 100)], 30);
    expect(plan.allocations).toEqual([{ lotId: "a", amount: 30 }]);
    expect(plan.shortfall).toBe(0);
  });

  it("按给定顺序摊到多笔上，先给的先花光", () => {
    // 调用方按 created_at 升序把笔交进来，所以这里的顺序就是先充先花。
    const plan = planCharge([lot("a", 30), lot("b", 100)], 50);
    expect(plan.allocations).toEqual([
      { lotId: "a", amount: 30 },
      { lotId: "b", amount: 20 },
    ]);
    expect(plan.shortfall).toBe(0);
  });

  it("正好花光一笔时不给下一笔留零额分配", () => {
    // 一条 amount 为 0 的流水记的是「什么都没发生」，逐笔对账时是噪音。
    const plan = planCharge([lot("a", 30), lot("b", 100)], 30);
    expect(plan.allocations).toEqual([{ lotId: "a", amount: 30 }]);
  });

  it("笔不够时把能扣的全扣掉，把差额单独报出来", () => {
    // 这一层不回滚：用户已经拿到产物，账我们自己补。差额由调用方记进
    // 对账日志（domain 不写日志）。
    const plan = planCharge([lot("a", 30), lot("b", 10)], 100);
    expect(plan.allocations).toEqual([
      { lotId: "a", amount: 30 },
      { lotId: "b", amount: 10 },
    ]);
    expect(plan.shortfall).toBe(60);
  });

  it("一笔都没有时全额是差额，且一条分配都不产生", () => {
    const plan = planCharge([], 100);
    expect(plan.allocations).toEqual([]);
    expect(plan.shortfall).toBe(100);
  });

  it("跳过剩余为零的笔", () => {
    // 取笔的查询已经滤掉它们，这里是第二道：一条零额流水会让逐笔对账
    // 多出一行没有意义的记录。
    const plan = planCharge([lot("a", 0), lot("b", 50)], 20);
    expect(plan.allocations).toEqual([{ lotId: "b", amount: 20 }]);
  });

  it("扣零时什么都不做", () => {
    const plan = planCharge([lot("a", 50)], 0);
    expect(plan.allocations).toEqual([]);
    expect(plan.shortfall).toBe(0);
  });

  it("任意笔序和任意扣额下，分配总额加差额恒等于要扣的量，且没有一笔被扣超", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 10 ** 9 }), { maxLength: 20 }),
        fc.integer({ min: 0, max: 10 ** 10 }),
        (remainings, amount) => {
          const lots = remainings.map((r, i) => lot(`lot-${i}`, r));
          const plan = planCharge(lots, amount);

          const allocated = plan.allocations.reduce((sum, a) => sum + a.amount, 0);
          // 不多扣也不少扣：这是「不凭空吃掉用户的钱」的算术面。
          expect(allocated + plan.shortfall).toBe(amount);
          expect(plan.shortfall).toBeGreaterThanOrEqual(0);

          for (const a of plan.allocations) {
            const source = lots.find((l) => l.id === a.lotId);
            // 单笔永不扣超，所以剩余永远落不到负数。
            expect(a.amount).toBeGreaterThan(0);
            expect(a.amount).toBeLessThanOrEqual(source!.remaining);
          }
        },
      ),
    );
  });
});
