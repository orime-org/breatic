// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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
  /** When set, the call sends this generation id and breaks off unrecorded. */
  cutOffAfter: null as string | null,
  /**
   * When set, the stream reports this error as a part, the way the SDK does
   * for a call the provider refused or broke off: after `textBefore`, if any.
   */
  streamError: null as Error | null,
  textBefore: "",
}));

const handOffLookups = vi.hoisted(() => vi.fn(async () => undefined));

/** 这一轮扣费成不成功。 */
const charge = vi.hoisted(() => ({
  fail: null as Error | null,
  calls: [] as unknown[][],
  /** What the settled charge says it took. */
  charged: "2000.000000",
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

/** What each recorder was opened with, and what it was told. */
const recorders = vi.hoisted(() => ({
  opened: [] as unknown[],
  calls: [] as unknown[],
  /** When set, the recorder's usage row could not be written. */
  writeFailure: null as Error | null,
}));

vi.mock("@breatic/domain", async () => ({
  handOffLookups,
  // A run cut off before its finish leaves its generation among the prepared call's pending costs.
  provider: () => ({
    llm: {
      prepare: () => ({
        model: {},
        options: { providerOptions: {}, maxRetries: 0 },
        system: () => [],
        pendingCosts: () =>
          modelRun.cutOffAfter === null ? [] : [{ state: "pending", lookup: { upstream: "openrouter", generationId: modelRun.cutOffAfter } }],
      }),
      costOf: () => ({ state: "known", usd: 0.01, source: "reported", tokens: { input: 0, cachedInput: 0, output: modelRun.tokens, reasoning: 0 } }),
      servedBy: () => "served-upstream",
    },
  }),
  // The model call reports its usage as its response arrives, the way the SDK
  // calls `onLanguageModelCallEnd`, before the stream is drained.
  streamTextRetry: (opts: {
    includeRawChunks?: boolean;
    onChunk?: (event: { chunk: { type: string; rawValue?: unknown } }) => void;
    onLanguageModelCallEnd?: (event: {
      responseId: string;
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
      providerMetadata: Record<string, unknown>;
    }) => void;
  }) => {
    if (modelRun.failsWith) throw modelRun.failsWith;
    return {
      fullStream: (async function* () {
        if (modelRun.streamError !== null) {
          if (modelRun.textBefore !== "") yield { type: "text-delta", text: modelRun.textBefore };
          yield { type: "error", error: modelRun.streamError };
          return;
        }
        if (modelRun.cutOffAfter !== null) {
          if (opts.includeRawChunks) {
            opts.onChunk?.({ chunk: { type: "raw", rawValue: { id: modelRun.cutOffAfter } } });
          }
          yield { type: "text-delta", text: "o" };
          return;
        }
        opts.onLanguageModelCallEnd?.({
          responseId: "gen-done",
          usage: { inputTokens: 0, outputTokens: modelRun.tokens, totalTokens: modelRun.tokens },
          // A call that ended normally carries the cost its route reports.
          providerMetadata: { openrouter: { usage: { cost: 0.01 } } },
        });
        yield { type: "text-delta", text: "ok" };
      })(),
    };
  },
  // Counts a credit per output token; pricing is provider's to test.
  createUsageRecorder: (options: {
    operationKey: string;
    feature: string;
    actorUserId: string;
    projectId: string | null;
  }) => {
    recorders.opened.push(options);
    let credits = 0;
    const { operationKey, feature, actorUserId, projectId } = options;
    return {
      operation: { operationKey, feature, actorUserId, projectId },
      recordModelCall: (call: { cost: { tokens?: { output: number } } }) => {
        recorders.calls.push(call);
        credits += call.cost.tokens?.output ?? 0;
      },
      recordServiceCall: () => {},
      awaitingLookup: () => [],
      settle: async () => {
        if (recorders.writeFailure) throw recorders.writeFailure;
        return credits;
      },
      settleForCharge: async () => ({
        credits,
        writeFailures: recorders.writeFailure ? [recorders.writeFailure] : [],
      }),
    };
  },
  creditLotService: {
    chargeOnce: async (...args: unknown[]) => {
      charge.calls.push(args);
      if (charge.fail) throw charge.fail;
      return { billed: true, charged: charge.charged, shortfall: "0.000000", studioId: null, lotIds: [] };
    },
  },
}));

vi.mock("ai", () => ({ stepCountIs: () => () => false }));

// Partial: whatever else the service reads from its config (the thinking level,
// inner#1860) comes from the shipped file.
vi.mock("@server/config/text-tools.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getModelForTool: () => "openai/gpt-4o-mini",
  getPromptForTool: () => "system",
}));

/** The project the run belongs to; its studio pays (inner#1860). */
const PROJECT = "11111111-1111-4111-8111-111111111111";

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
    PROJECT,
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
  charge.charged = "2000.000000";
  recorders.writeFailure = null;
  recorders.opened = [];
  recorders.calls = [];
  modelRun.tokens = 2000;
  modelRun.failsWith = null;
  modelRun.cutOffAfter = null;
  modelRun.streamError = null;
  modelRun.textBefore = "";
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
    expect(message).toBe("credit_charge_settle_failed");
    expect(ctx).toMatchObject({ userId: "u-1", tool: "generate", tokens: 2000 });
    expect(ctx.err).toBe(charge.fail);
    // What finds the pending request the sweep will settle: its key and amount.
    expect(charge.calls).toHaveLength(1);
    expect(ctx).toMatchObject({ refKey: charge.calls[0]![1], amount: (charge.calls[0]![2] as { amount: number }).amount });
  });

  it("reports zero credits used when the charge fails", async () => {
    charge.fail = new Error("boom");

    const events = await run();

    expect(events.at(-1)).toMatchObject({ type: "done", creditsUsed: "0.000000" });
  });

  it("reports what the settled charge took as the credits used", async () => {
    charge.charged = "1500.000000";

    const events = await run();

    expect(events.at(-1)).toMatchObject({ type: "done", tokens: 2000, creditsUsed: "1500.000000" });
  });

  it("charges the full amount when a usage row could not be written, and logs the row", async () => {
    // inner#1617: a lost usage row must not lose the charge.
    recorders.writeFailure = new Error("usage row insert failed");

    const events = await run();

    expect(events.at(-1)).toMatchObject({ type: "done", creditsUsed: "2000.000000" });
    expect(charge.calls).toHaveLength(1);
    expect(charge.calls[0]?.[2]).toMatchObject({ amount: 2000 });
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ err: recorders.writeFailure }),
      "agent_usage_record_failed",
    );
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

    expect(charge.calls[0]?.[0]).toBe("operation");
    expect(charge.calls[0]?.[2]).toMatchObject({
      model: "openai/gpt-4o-mini",
      provider: "served-upstream",
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

describe("a model call the provider refuses or breaks off", () => {
  it("ends with an error event when the call is refused before any words", async () => {
    modelRun.streamError = new Error("provider refused");

    const events = await run();

    expect(events.map((event) => event.type)).toEqual(["error"]);
  });

  it("ends with an error event, not done, when it breaks off after some words", async () => {
    modelRun.streamError = new Error("provider broke off");
    modelRun.textBefore = "half an ans";

    const events = await run();

    expect(events.map((event) => event.type)).toEqual(["text_delta", "error"]);
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

  it("死在 token 数读出来之后，那些 token 照样计费", async () => {
    // 这是 catch 里那次扣费存在的唯一理由。消费方在收到事件时抛出，异常
    // 从挂起的 yield 处回到这个 try 里，而 totalTokens 已经有值了 ——
    // 模型的账已经产生，谁读走了结果不改变这件事。
    const gen = executeTextTool(
      "u-1",
      PROJECT,
      "generate",
      { instructions: "写点什么" },
      new AbortController().signal,
      "key-1",
    );
    await gen.next();
    await gen.next();

    const thrown = await gen.throw(new Error("consumer gone"));

    expect(thrown.value).toMatchObject({ type: "error" });
    expect(charge.calls).toHaveLength(2);
    // 同一个幂等键，所以两次里只有一次真扣得下去。
    expect(charge.calls[1]?.[1]).toBe(charge.calls[0]?.[1]);
    expect(charge.calls[1]?.[2]).toMatchObject({ amount: 2000 });
  });
});

describe("a run cut off before the model reported its cost", () => {
  it("hands the call to the later lookup", async () => {
    modelRun.cutOffAfter = "gen-42";

    await run();

    expect(handOffLookups).toHaveBeenCalledWith(
      [{ upstream: "openrouter", generationId: "gen-42" }],
      { operationKey: "texttool:key-1", feature: "text_tool", actorUserId: "u-1", projectId: PROJECT },
      { model: "openai/gpt-4o-mini", description: "Text tool: generate", charge: true },
    );
  });

  it("hands nothing off when the call ended and was recorded", async () => {
    await run();

    expect(handOffLookups).not.toHaveBeenCalled();
  });
});

describe("what a run records", () => {
  it("records the model call under the key it is charged under", async () => {
    await run();

    expect(recorders.opened).toEqual([
      expect.objectContaining({
        operationKey: "texttool:key-1",
        feature: "text_tool",
        actorUserId: "u-1",
        projectId: PROJECT,
      }),
    ]);
    expect(recorders.calls).toEqual([
      expect.objectContaining({
        source: "model",
        model: "openai/gpt-4o-mini",
        upstream: "served-upstream",
      }),
    ]);
    expect(charge.calls[0]?.[0]).toBe("operation");
    expect(charge.calls[0]?.[1]).toBe("texttool:key-1");
    expect(charge.calls[0]?.[2]).toMatchObject({ amount: 2000, projectId: PROJECT, actorUserId: "u-1" });
  });
});

export type { CoreModule };
