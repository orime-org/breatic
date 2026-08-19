// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The one line a finished turn leaves behind, and the two fields on it.
 *
 * `agent_response` is what someone reads at three in the morning to find out
 * what a turn did: how much it said, and how it ended. Both fields are built
 * inside the loop this migration removes -- `exit` comes from a variable the
 * loop sets on its way out, `responseLength` from prose the loop accumulates
 * -- so both need somewhere else to come from, and nothing currently notices
 * if they arrive empty.
 *
 * These assertions hold today. They are written now because the path they
 * describe is about to be rewritten and has no other cover: a turn that
 * logged `exit: "completed"` for a turn the user stopped would read as normal
 * for as long as nobody went looking.
 *
 * Design: inner `engineering/specs/2026-08-19-usechat-migration-design.md`
 * 13.5.2. Acceptance A18.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as CoreModule from "@breatic/core";

const streamTextRetry = vi.fn();
const logInfo = vi.fn();

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
  const logger = { info: logInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    ...base,
    runWithContext: actual.runWithContext,
    getContext: actual.getContext,
    logger: { ...logger, child: () => logger },
  };
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
 * @param stop - Raised part way through, when given.
 * @returns The fields of the `agent_response` line.
 */
async function turnLog(
  parts: Array<Record<string, unknown>>,
  stop?: AbortController,
): Promise<Record<string, unknown> | undefined> {
  streamTextRetry.mockReturnValue({
    fullStream: (async function* () {
      for (const part of parts) {
        if (stop?.signal.aborted) return;
        yield part;
      }
    })(),
    toUIMessageStream: () => new ReadableStream(),
  });

  const { MainAgent } = await import("@server/agent/main-agent.js");
  const { runWithContext } = await import("@breatic/core");
  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    for await (const _frame of new MainAgent().chat("说点什么", undefined, stop?.signal)) {
      if (stop && !stop.signal.aborted) stop.abort();
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
    const line = await turnLog([
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", text: "十二个字的回答" },
      { type: "text-end", id: "t1" },
      { type: "finish", finishReason: "stop" },
    ]);

    // Zero here is what a turn that answered nothing looks like, so a field
    // that silently stopped being filled reads as a product that stopped
    // answering.
    expect(line?.responseLength).toBe("十二个字的回答".length);
  });

  it("names a normal ending", async () => {
    const line = await turnLog([{ type: "finish", finishReason: "stop" }]);
    expect(line?.exit).toBe("completed");
  });

  it("names a provider failure as one", async () => {
    // Not "completed with no text": the difference is the whole reason
    // anyone reads this line.
    const line = await turnLog([
      { type: "error", error: new Error("provider said no") },
      { type: "finish", finishReason: "error" },
    ]);
    expect(line?.exit).toBe("failed");
  });

  it("carries the user and the conversation, or the line names nothing", async () => {
    const line = await turnLog([{ type: "finish", finishReason: "stop" }]);
    expect(line?.userId).toBe("u1");
    expect(line?.conversationId).toBe("c1");
  });
});
