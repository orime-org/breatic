// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 一次模型调用按 token 换算成多少积分。
 *
 * 三处按 token 计费的地方共用这一个算式：聊天的一轮、记忆归纳、文本 mini-tool。
 * 各写各的时候，三处的取整或倍率一旦分头改，同样的活会按不同的价钱扣两个人的钱。
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@breatic/core", () => ({ env: { CREDIT_MULTIPLIER: 2 } }));

const { creditsForTokens } = await import("@server/modules/credit/token-pricing.js");

describe("按 token 计价", () => {
  it("一千 token 一个积分，再乘部署的倍率", () => {
    expect(creditsForTokens(1000)).toBe(2);
    expect(creditsForTokens(3000)).toBe(6);
  });

  it("不足一个积分的向上取整", () => {
    // 抹零会让每次小调用都免费，而小调用正是最频繁的那种。
    expect(creditsForTokens(1)).toBe(1);
    expect(creditsForTokens(499)).toBe(1);
  });

  it("一个 token 都没用就不收钱", () => {
    expect(creditsForTokens(0)).toBe(0);
  });
});
