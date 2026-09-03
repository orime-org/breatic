// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 保守时间怎么算出来（#186，设计 §4.6.2）。
 *
 * 这个数只有一个用途：到点判死。所以取值方向是宁可长、不能误杀 —— 误杀
 * 是把一条正在正常跑的任务判死（用户白等、钱白花），晚判只是用户多等一会。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@breatic/core", () => ({
  getStorageConfig: () => ({
    upload: {
      max_upload_bytes: 2 * 1024 * 1024 * 1024,
      client_put_min_bytes_per_sec: 65_536,
    },
  }),
  getNodeTaskConfig: () => ({
    upload: {
      min_budget_ms: 900_000,
      max_budget_ms: 43_200_000,
      cover_reserve_ms: 600_000,
    },
  }),
}));

const { uploadBudgetMs } = await import("@domain/node-task/budget.js");

const MIN = 900_000;
const MAX = 43_200_000;
const RESERVE = 600_000;
const RATE = 65_536;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("上传任务的保守时间", () => {
  it("按最慢可接受的速率算传输时间，再加封面预留", () => {
    // 40 MiB ÷ 64 KB/s = 640 秒；加 10 分钟封面预留 = 1240 秒。
    const size = 40 * 1024 * 1024;
    expect(uploadBudgetMs(size)).toBe((size / RATE) * 1000 + RESERVE);
  });

  it("小文件也给足下限", () => {
    // 一张 100 KB 的图按速率只要 1.5 秒，而这段时间里还有握手、
    // 建行、签票据、浏览器排队。下限是这些的容身处。
    expect(uploadBudgetMs(100 * 1024)).toBe(MIN);
  });

  it("允许上传的最大文件不会被上限夹到", () => {
    // 2 GiB ÷ 64 KB/s = 9.1 小时，上限 12 小时特意排在它上面：
    // 最大的那个文件由它自己的传输估算定，不由这个数定。
    const budget = uploadBudgetMs(2 * 1024 * 1024 * 1024);
    expect(budget).toBeLessThan(MAX);
    expect(budget).toBe(
      (2 * 1024 * 1024 * 1024 / RATE) * 1000 + RESERVE,
    );
  });

  it("超过上限的估算被夹回上限", () => {
    // 票据端点在 2 GiB 就拒了，所以这个值到不了这里。上限存在是因为
    // 一个能被算大的数不该变成一个几天都不判死的闹钟。
    expect(uploadBudgetMs(100 * 1024 * 1024 * 1024)).toBe(MAX);
  });

  it("上限之内的值原样保留，不被夹", () => {
    const size = 500 * 1024 * 1024;
    const raw = (size / RATE) * 1000 + RESERVE;
    expect(raw).toBeGreaterThan(MIN);
    expect(raw).toBeLessThan(MAX);
    expect(uploadBudgetMs(size)).toBe(raw);
  });

  it("零字节和负数都落到下限", () => {
    // 票据端点已经把这两种挡在外面了；这里不抛，是因为一个判死用的
    // 时长没有「算不出来」这个出口，算不出来就给最短的那个。
    expect(uploadBudgetMs(0)).toBe(MIN);
    expect(uploadBudgetMs(-1)).toBe(MIN);
  });

  it("给出的是整毫秒", () => {
    // setAlarm 收的是一个时刻，小数在那儿没有意义。
    expect(Number.isInteger(uploadBudgetMs(12_345))).toBe(true);
    expect(Number.isInteger(uploadBudgetMs(999_999_999))).toBe(true);
  });

  it("文件越大给的时间越长", () => {
    const small = uploadBudgetMs(50 * 1024 * 1024);
    const large = uploadBudgetMs(500 * 1024 * 1024);
    expect(large).toBeGreaterThan(small);
  });
});
