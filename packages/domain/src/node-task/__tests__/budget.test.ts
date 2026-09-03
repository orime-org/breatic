// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How a conservative time is arrived at (#186, design §4.6.2).
 *
 * The number has one use: judging a task dead. So it is biased long —
 * killing a live task costs the user their wait and their credits, judging
 * late costs them a longer wait.
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

describe("an upload's conservative time", () => {
  it("estimates the transfer at the slowest acceptable rate, then adds the cover reserve", () => {
    // 40 MiB at 64 KB/s is 640 seconds; plus ten minutes for the cover.
    const size = 40 * 1024 * 1024;
    expect(uploadBudgetMs(size)).toBe((size / RATE) * 1000 + RESERVE);
  });

  it("gives a small file the floor", () => {
    // A 100 KB image transfers in a second and a half, while the handshake,
    // the row, the signed ticket and the browser's own queueing do not. The
    // floor is where those live.
    expect(uploadBudgetMs(100 * 1024)).toBe(MIN);
  });

  it("leaves the largest allowed file unclamped", () => {
    // 2 GiB at 64 KB/s is 9.1 hours, and the 12-hour ceiling deliberately
    // sits above it: that file is bounded by its own transfer estimate.
    const budget = uploadBudgetMs(2 * 1024 * 1024 * 1024);
    expect(budget).toBeLessThan(MAX);
    expect(budget).toBe(((2 * 1024 * 1024 * 1024) / RATE) * 1000 + RESERVE);
  });

  it("holds an estimate above the ceiling down to it", () => {
    // The ticket endpoint refuses anything past 2 GiB, so this size never
    // reaches here. The ceiling exists so that a number which can be made
    // large cannot become an alarm that waits days to judge anything.
    expect(uploadBudgetMs(100 * 1024 * 1024 * 1024)).toBe(MAX);
  });

  it("keeps an in-range estimate exactly as computed", () => {
    const size = 500 * 1024 * 1024;
    const raw = (size / RATE) * 1000 + RESERVE;
    expect(raw).toBeGreaterThan(MIN);
    expect(raw).toBeLessThan(MAX);
    expect(uploadBudgetMs(size)).toBe(raw);
  });

  it("puts zero and negative sizes on the floor", () => {
    // The ticket endpoint already refuses both. Nothing is thrown here
    // because a deadline has no "cannot say" outlet: it takes the shortest
    // time on offer.
    expect(uploadBudgetMs(0)).toBe(MIN);
    expect(uploadBudgetMs(-1)).toBe(MIN);
  });

  it("answers in whole milliseconds", () => {
    // `setAlarm` takes an instant, where a fraction means nothing.
    expect(Number.isInteger(uploadBudgetMs(12_345))).toBe(true);
    expect(Number.isInteger(uploadBudgetMs(999_999_999))).toBe(true);
  });

  it("gives a larger file more time", () => {
    const small = uploadBudgetMs(50 * 1024 * 1024);
    const large = uploadBudgetMs(500 * 1024 * 1024);
    expect(large).toBeGreaterThan(small);
  });
});
