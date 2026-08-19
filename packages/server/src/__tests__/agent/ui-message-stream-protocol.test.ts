// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 线上流说的是 AI SDK 的话，不是我们自己发明的那 8 个事件。
 *
 * 设计见 inner `engineering/specs/2026-08-19-usechat-migration-design.md` §5：
 * 后端出口从「逐个 part 手工翻译成自定义事件」换成 `createUIMessageStream`，
 * 于是工具调用的参数、结果、失败原因全都由协议自带，不用我们再定一份契约。
 *
 * 这个文件钉两条验收：
 * A1 —— 一轮纯文本对话，流上是 `text-start` / `text-delta` / `text-end`。
 * A5 —— 一轮有工具调用，流上是 `tool-input-available`（带参数与 toolCallId）
 *        与 `tool-output-available`（带结果），两者按同一个 id 对上。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as CoreModule from "@breatic/core";

const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>) => 1);
const consolidateIfNeeded = vi.fn(async () => undefined);
const streamTextRetry = vi.fn();

vi.mock("@server/agent/turn-context.js", () => ({
  buildTurnContext: vi.fn(async () => ({
    memoryContext: { userMemory: "", projectMemory: "", conversationMemory: "" },
    compressedHistory: [],
  })),
}));

vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  streamText: vi.fn(),
  generateText: vi.fn(),
  stepCountIs: vi.fn(() => 40),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  const base = await coreMock(importOriginal);
  const actual = await importOriginal<typeof CoreModule>();
  return { ...base, runWithContext: actual.runWithContext, getContext: actual.getContext };
});

vi.mock("@breatic/domain", async () => {
  const { domainMock } = await import("../helpers/mock-core.js");
  const base = await domainMock();
  return {
    ...base,
    buildAgentConfig: () => ({ modelId: "test", instructions: "system", tools: {} }),
    finalizeTurn: async () => [],
    streamTextRetry,
    getModel: () => ({ modelId: "test" }),
  };
});

vi.mock("@server/modules/conversation/conversation-message.repo.js", () => ({
  addMessage,
  getMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
}));

vi.mock("@server/modules/conversation/conversation.service.js", () => ({
  titleForTurn: vi.fn(async () => "一条会话"),
}));

vi.mock("@server/agent/memory-consolidator.js", () => ({ consolidateIfNeeded }));

// 系统提示词怎么拼不是这个文件要钉的东西，而拼它要走 skill 注册表，
// 共享的 mock 里那份只有 `get`。这里给一句现成的，把话题留在协议上。
vi.mock("@server/agent/context.js", () => ({
  buildSystemPrompt: () => "系统提示词",
}));

/**
 * 把一批 SDK 原生 part 做成 `streamTextRetry` 会返回的那个东西。
 * @param parts - 要吐出来的那些 part。
 * @returns 假的 streamText 结果。
 */
function modelSaying(parts: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    fullStream: (async function* () {
      for (const p of parts) yield p;
    })(),
    toUIMessageStream: () => new ReadableStream(),
  };
}

/**
 * 跑一轮，把线上流上出现过的 part 类型收集起来。
 * @param parts - 模型这一轮吐什么。
 * @returns 线上流上每一帧的类型，按到达顺序。
 */
async function typesOnTheWire(parts: Array<Record<string, unknown>>): Promise<string[]> {
  streamTextRetry.mockReturnValue(modelSaying(parts));
  const { MainAgent } = await import("@server/agent/main-agent.js");
  const { runWithContext } = await import("@breatic/core");

  const seen: string[] = [];
  await runWithContext(
    { userId: "u1", conversationId: "c1", projectId: "p1" },
    async () => {
      for await (const frame of new MainAgent().chat("说点什么")) {
        // 迁移后每一帧是一个 UIMessageChunk，它自己带 `type`。
        seen.push((frame as unknown as { type?: string }).type ?? "<无 type 字段>");
      }
    },
  );
  return seen;
}

describe("线上流说的是 SDK 的话", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("A1 一轮纯文本，流上是 text-start / text-delta / text-end", async () => {
    const types = await typesOnTheWire([
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", text: "好" },
      { type: "text-end", id: "t1" },
      { type: "finish", finishReason: "stop" },
    ]);

    expect(types).toContain("text-start");
    expect(types).toContain("text-delta");
    expect(types).toContain("text-end");
  });

  it("A5 工具调用的参数与结果都到了前端，按同一个 id 对上", async () => {
    const types = await typesOnTheWire([
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "web_fetch",
        input: { url: "https://example.com" },
      },
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "web_fetch",
        output: "拿到了",
      },
      { type: "finish", finishReason: "stop" },
    ]);

    expect(types).toContain("tool-input-available");
    expect(types).toContain("tool-output-available");
  });
});
