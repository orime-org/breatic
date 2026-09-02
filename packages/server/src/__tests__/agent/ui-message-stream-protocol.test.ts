// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 线上流说的是 AI SDK 的话，不是我们自己发明的那 8 个事件。
 *
 * 后端出口从「`for await` 循环加 `switch (part.type)`，逐个改写成自定义事件」
 * 换成 `createUIMessageStream`，于是工具调用的参数、结果、失败原因全都由协议
 * 自带，不用我们再定一份契约。
 *
 * 这个文件钉两条：一轮纯文本对话，流上是 `text-start` / `text-delta` /
 * `text-end`；一轮有工具调用，流上是 `tool-input-available`（带参数与
 * toolCallId）与 `tool-output-available`（带结果），两者按同一个 id 对上。
 *
 * 替身放在**模型**那一层，不放在 `streamTextRetry` 上。这两条要钉的正是
 * 「模型吐出来的东西经 SDK 变成什么上线」，把 `streamTextRetry` 换成替身就等于
 * 把这段转换自己 mock 掉，剩下的只是「喂什么吐什么」。换掉模型之后 `streamText`
 * 真跑：工具由它按模型的请求真调，`tool-output-available` 是真执行的结果。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import type * as CoreModule from "@breatic/core";
import { FINISHED } from "../helpers/model-double.js";
import type { ModelStreamPart } from "../helpers/model-double.js";

const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>) => 1);
const foldIfOverBudget = vi.fn(async () => false);

/** 这一轮模型吐什么，逐个用例改写。 */
const modelSays = vi.hoisted(() => ({ parts: [] as ModelStreamPart[] }));

/** 被调用过的工具参数，用来确认工具是真跑了而不是被跳过。 */
const webFetchCalledWith = vi.fn();

vi.mock("@server/agent/turn-context.js", () => ({
  buildTurnContext: vi.fn(async () => ({
    memoryContext: { projectMemory: "", conversationMemory: "" },
    compressedHistory: [],
  })),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  const base = await coreMock(importOriginal);
  const actual = await importOriginal<typeof CoreModule>();
  return { ...base, runWithContext: actual.runWithContext, getContext: actual.getContext };
});

vi.mock("@breatic/domain", async (importOriginal) => {
  const { domainMock } = await import("../helpers/mock-core.js");
  const base = await domainMock();
  const actual = await importOriginal<Record<string, unknown>>();
  const { modelProducing } = await import("../helpers/model-double.js");
  return {
    ...base,
    // 真的那个：它只是 `streamText` 加一个重试预算，而这两条要钉的就是
    // `streamText` 之后发生的事。
    streamTextRetry: actual.streamTextRetry,
    buildAgentConfig: () => ({
      modelId: "test",
      instructions: "system",
      tools: {
        web_fetch: tool({
          description: "取一个网页",
          inputSchema: z.object({ url: z.string() }),
          execute: async (input: { url: string }) => {
            webFetchCalledWith(input);
            return "拿到了";
          },
        }),
      },
    }),
    finalizeTurn: async () => [],
    getModel: () => modelProducing(() => modelSays.parts),
  };
});

vi.mock("@server/modules/conversation/conversation-message.repo.js", () => ({
  addMessage,
  getMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
}));

vi.mock("@server/modules/conversation/conversation.service.js", () => ({
  titleForTurn: vi.fn(async () => "一条会话"),
}));

vi.mock("@server/agent/turn-budget.js", () => ({ foldIfOverBudget }));

// 系统提示词怎么拼不是这个文件要钉的东西，而拼它要走 skill 注册表，
// 共享的 mock 里那份只有 `get`。这里给一句现成的，把话题留在协议上。
vi.mock("@server/agent/context.js", () => ({
  buildSystemPrompt: () => "系统提示词",
}));

/**
 * 跑一轮，把线上流上出现过的每一帧收集起来。
 * @param parts - 模型这一轮吐什么，用 provider 那一层的片段说。
 * @returns 线上流上的每一帧，按到达顺序。
 */
async function framesOnTheWire(
  parts: ModelStreamPart[],
): Promise<Array<Record<string, unknown>>> {
  modelSays.parts = parts;
  const { MainAgent } = await import("@server/agent/main-agent.js");
  const { runWithContext } = await import("@breatic/core");

  const seen: Array<Record<string, unknown>> = [];
  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    const turn = await new MainAgent().chat("说点什么");
    for await (const chunk of turn) {
      seen.push(chunk);
    }
  });
  return seen;
}

describe("线上流说的是 SDK 的话", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("A1 一轮纯文本，流上是 text-start / text-delta / text-end", async () => {
    const frames = await framesOnTheWire([
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "好" },
      { type: "text-end", id: "t1" },
      FINISHED,
    ]);

    const types = frames.map((f) => f.type);
    expect(types).toContain("text-start");
    expect(types).toContain("text-delta");
    expect(types).toContain("text-end");
    expect(frames.find((f) => f.type === "text-delta")?.delta).toBe("好");
  });

  it("A5 工具调用的参数与结果都到了前端，按同一个 id 对上", async () => {
    const frames = await framesOnTheWire([
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "web_fetch",
        input: JSON.stringify({ url: "https://example.com" }),
      },
      FINISHED,
    ]);

    // 工具真跑过：结果是它返回的，不是这个文件编的。
    expect(webFetchCalledWith).toHaveBeenCalledWith({ url: "https://example.com" });

    const asked = frames.find((f) => f.type === "tool-input-available");
    const answered = frames.find((f) => f.type === "tool-output-available");

    // 参数和结果都在，这正是迁移前到不了前端的那两样：旧的循环里没有写
    // 转发它们的代码，所以协议里有位置也没人填。
    expect(asked?.input).toEqual({ url: "https://example.com" });
    expect(answered?.output).toBe("拿到了");

    // 同一个 id：前端认得出这一问一答是同一次调用，靠的就是它。
    expect(asked?.toolCallId).toBe("call-1");
    expect(answered?.toolCallId).toBe("call-1");
  });
});
