// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The one line a finished turn leaves behind, and the two fields on it.
 *
 * `agent_response` is what someone reads at three in the morning to find out
 * what a turn did: how much it said, and how it ended. Both fields used to be
 * built inside the hand-written stream loop -- `exit` from a variable the
 * loop set on its way out, `responseLength` from prose it accumulated -- and
 * that loop is gone. Both now come from `onFinish`: `exit` from `isAborted`
 * and whether anything failed, `responseLength` from the reply's own parts.
 *
 * These cases were written before that move and are what carried the two
 * fields across it. Nothing else notices if they arrive empty: a turn that
 * logged `exit: "completed"` for a turn the user stopped would read as normal
 * for as long as nobody went looking.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as CoreModule from "@breatic/core";
import { FINISHED, saying } from "../helpers/model-double.js";
import type { ModelStreamPart } from "../helpers/model-double.js";

const logInfo = vi.fn();

/** What the model produces this case. */
const modelSays = vi.hoisted(() => ({ parts: [] as unknown[], failsToStart: null as Error | null }));

vi.mock("@server/agent/turn-context.js", () => ({
  buildTurnContext: vi.fn(async () => ({
    memoryContext: { userMemory: "", projectMemory: "", conversationMemory: "" },
    compressedHistory: [],
  })),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  const base = await coreMock(importOriginal);
  const actual = await importOriginal<typeof CoreModule>();
  const logger = { info: logInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    ...base,
    runWithContext: actual.runWithContext,
    getContext: actual.getContext,
    logger: { ...logger, child: () => logger },
  };
});

vi.mock("@breatic/domain", async (importOriginal) => {
  const { domainMock } = await import("../helpers/mock-core.js");
  const base = await domainMock();
  const actual = await importOriginal<Record<string, unknown>>();
  const { modelProducing, modelFailingToStart } = await import("../helpers/model-double.js");
  return {
    ...base,
    streamTextRetry: actual.streamTextRetry,
    buildAgentConfig: () => ({ modelId: "test", instructions: "system", tools: {} }),
    finalizeTurn: async () => [],
    getModel: () =>
      modelSays.failsToStart
        ? modelFailingToStart(modelSays.failsToStart)
        : modelProducing(() => modelSays.parts as ModelStreamPart[]),
  };
});

vi.mock("@server/modules/conversation/conversation-message.repo.js", () => ({
  addMessage: vi.fn(async () => 1),
  getMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
}));

vi.mock("@server/modules/conversation/conversation.service.js", () => ({
  titleForTurn: vi.fn(async () => "一条会话"),
}));

vi.mock("@server/agent/memory-consolidator.js", () => ({
  consolidateIfNeeded: vi.fn(async () => undefined),
}));

vi.mock("@server/agent/context.js", () => ({
  buildSystemPrompt: () => "系统提示词",
}));

/**
 * Run a turn on a given script and report the line it logged at the end.
 * @param parts - What the model produces.
 * @returns The fields of the `agent_response` line.
 */
async function turnLog(parts: ModelStreamPart[]): Promise<Record<string, unknown> | undefined> {
  modelSays.parts = parts;
  modelSays.failsToStart = null;

  const { MainAgent } = await import("@server/agent/main-agent.js");
  const { runWithContext } = await import("@breatic/core");
  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    const turn = await new MainAgent().chat("说点什么");
    for await (const _chunk of turn) {
      // Drained rather than read: what this asserts on is the line written
      // when the turn is over, not what came out of it.
    }
  });

  const line = logInfo.mock.calls.find((call) => call[1] === "agent_response");
  return line?.[0] as Record<string, unknown> | undefined;
}

describe("what a finished turn writes to the log", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("says how much the turn said", async () => {
    const line = await turnLog(saying("十二个字的回答"));

    // Zero here is what a turn that answered nothing looks like, so a field
    // that silently stopped being filled reads as a product that stopped
    // answering.
    expect(line?.responseLength).toBe("十二个字的回答".length);
  });

  it("names a normal ending", async () => {
    const line = await turnLog(saying("好的"));
    expect(line?.exit).toBe("completed");
  });

  it("names the model the turn actually ran on", async () => {
    // Which model answered is a deployment question with no other answer:
    // the config says what was asked for, and nothing else says what was
    // used. Reading it back out of a credit ledger row is not something
    // anyone does at three in the morning.
    const line = await turnLog(saying("好的"));
    expect(line?.modelId).toBe("test");
  });

  it("names a provider failure as one", async () => {
    // A provider failure does not break the stream: the SDK puts an error
    // chunk on it and closes it normally, so a turn that went by whether the
    // stream ended cleanly would call this one completed -- which is the
    // opposite of what anyone reads this line for.
    const line = await turnLog([
      { type: "error", error: new Error("上游拒绝了") },
      FINISHED,
    ]);
    expect(line?.exit).toBe("failed");
  });

  it("names a call that never got off the ground as a failure too", async () => {
    // 请求在出门前就被判非法（SDK 校验它正要发的东西）—— 这时流上一个字都
    // 没有过。日志漏记它，就等于一轮什么都没发生、也没人知道。
    modelSays.parts = [];
    modelSays.failsToStart = new Error("上游拒收这份请求");

    const { MainAgent } = await import("@server/agent/main-agent.js");
    const { runWithContext } = await import("@breatic/core");
    const chunks: Array<{ type: string }> = [];
    await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
      const turn = await new MainAgent().chat("说点什么");
      for await (const chunk of turn) chunks.push(chunk);
    });

    // 客户端必须听见这一轮完了。听不见的话，屏幕上就是按了发送之后什么都
    // 不发生 —— 输入框锁着，等一个永远不来的回复。
    expect(chunks.map((c) => c.type)).toContain("error");
    const line = logInfo.mock.calls.find((call) => call[1] === "agent_response");
    expect((line?.[0] as Record<string, unknown> | undefined)?.exit).toBe("failed");
  });

  it("carries the user and the conversation, or the line names nothing", async () => {
    const line = await turnLog(saying("好的"));
    expect(line?.userId).toBe("u1");
    expect(line?.conversationId).toBe("c1");
  });
});
