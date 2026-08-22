// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 一次文本工具跑完之后，钱那一步失败了会留下什么。
 *
 * 这条路上的失败对调用方是无声的：文字已经生成、已经流回去了，扣费在最后
 * 才发生，失败也不该把响应毁掉。所以它唯一能留下的东西就是日志 —— 没有日志
 * 就等于没发生过，而丢的是钱。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as CoreModule from "@breatic/core";

const logError = vi.fn();

/** 这一轮模型吐什么、用了多少 token。 */
const modelRun = vi.hoisted(() => ({
  tokens: 0,
  failsWith: null as Error | null,
}));

/** 这一轮扣费成不成功。 */
const charge = vi.hoisted(() => ({
  fail: null as Error | null,
  calls: [] as unknown[][],
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../../../__tests__/helpers/mock-core.js");
  const base = await coreMock(importOriginal);
  return {
    ...base,
    logger: { info: vi.fn(), warn: vi.fn(), error: logError, debug: vi.fn() },
    env: { ...(base as { env: object }).env, ENV: "test", CREDIT_MULTIPLIER: 1 },
  };
});

vi.mock("@breatic/domain", () => ({
  getModel: () => ({}),
  streamTextRetry: () => {
    if (modelRun.failsWith) throw modelRun.failsWith;
    return {
      fullStream: (async function* () {
        yield { type: "text-delta", text: "ok" };
      })(),
      usage: Promise.resolve({ totalTokens: modelRun.tokens }),
    };
  },
  // The real one routes on which API keys the deployment has, so a name
  // derived from the model string would assert the double, not the wiring.
  resolveProvider: (model: string) => `routed:${model}`,
  creditLotService: {
    chargeOnceForGeneration: async (...args: unknown[]) => {
      charge.calls.push(args);
      if (charge.fail) throw charge.fail;
      return { charged: 0, shortfall: 0, studioId: null, lotIds: [] };
    },
  },
}));

vi.mock("ai", () => ({ stepCountIs: () => () => false }));

vi.mock("@server/config/text-tools.js", () => ({
  getModelForTool: () => "openai/gpt-4o-mini",
  getPromptForTool: () => "system",
}));

const { executeTextTool } = await import(
  "@server/modules/text-tool/text-tool.service.js"
);

/**
 * 把一次运行读到底，返回它吐出的全部事件。
 * @returns 事件数组。
 */
async function run(): Promise<{ type: string }[]> {
  const events: { type: string }[] = [];
  for await (const event of executeTextTool(
    "u-1",
    "generate",
    { instructions: "写点什么" },
    new AbortController().signal,
    "key-1",
  )) {
    events.push(event);
  }
  return events;
}

beforeEach(() => {
  vi.clearAllMocks();
  charge.fail = null;
  charge.calls = [];
  modelRun.tokens = 2000;
  modelRun.failsWith = null;
});

describe("扣费失败", () => {
  it("留下一条带上下文的错误日志", async () => {
    // 扣费在文字流完之后才发生，失败不会毁掉响应，用户也看不出任何异样。
    // 凌晨三点有人来查「这次生成为什么没收到钱」时，能查的只有这一行。
    charge.fail = new Error("boom");

    const events = await run();

    expect(events.at(-1)?.type).toBe("done");
    expect(logError).toHaveBeenCalledTimes(1);
    const [ctx, message] = logError.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(message).toBe("text_tool_credit_charge_failed");
    expect(ctx).toMatchObject({ userId: "u-1", tool: "generate", tokens: 2000 });
    expect(ctx.err).toBe(charge.fail);
  });

  it("扣费成功时不记错误", async () => {
    await run();
    expect(charge.calls).toHaveLength(1);
    expect(logError).not.toHaveBeenCalled();
  });

  it("扣费带上这次用的模型和它的提供方", async () => {
    // 流水那四列存在的理由就是「一行数字答不出这次花在什么上」。文本工具跟
    // 画布生成写进同一张表，两边都得填。
    await run();

    expect(charge.calls[0]?.[1]).toMatchObject({
      model: "openai/gpt-4o-mini",
      provider: "routed:openai/gpt-4o-mini",
    });
  });

  it("一个 token 都没用时压根不去扣，也就无从失败", async () => {
    modelRun.tokens = 0;
    charge.fail = new Error("boom");

    await run();

    expect(charge.calls).toHaveLength(0);
    expect(logError).not.toHaveBeenCalled();
  });
});

describe("一次跑到一半就死掉的运行", () => {
  it("走 error 事件出去，一分钱都不扣", async () => {
    // The token count is only read once the stream has finished, so a run that
    // died before that used nothing anybody can be charged for.
    modelRun.failsWith = new Error("upstream gone");

    const events = await run();

    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(charge.calls).toHaveLength(0);
    expect(logError).not.toHaveBeenCalled();
  });
});

export type { CoreModule };
