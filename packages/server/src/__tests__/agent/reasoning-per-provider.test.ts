// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A chat turn asks for the model's working, and the ask reaches the model.
 *
 * Which upstream takes the request which way is provider's, and its tests
 * hold it; what is only observable from here is whether the turn asks for the
 * working and puts what provider prepared on the call at all. A turn that
 * worked it out and dropped it looks identical from outside, and that is what
 * used to happen: OpenRouter was reached through `createOpenAI`, which decides
 * from the model id whether a model reasons at all, so the option was dropped
 * before the request was built.
 *
 * The model is a double so the options can be read off the call.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as CoreModule from "@breatic/core";
import type * as DomainModule from "@breatic/domain";
import { saying } from "../helpers/model-double.js";
import type { MockLanguageModelV4 } from "ai/test";

/**
 * What the turn is told to run on, and the model it was actually handed.
 *
 * The model is kept because that is where the assertion is: these options
 * only matter if they reach the provider, and a call that carried them as far
 * as `streamText` and no further would look identical from outside.
 */
const runningOn = vi.hoisted(() => ({
  modelId: "",
  model: undefined as MockLanguageModelV4 | undefined,
}));

vi.mock("@server/agent/turn-context.js", () => ({
  buildTurnContext: vi.fn(async () => ({
    memoryContext: { entries: [], migrated: [], olderCount: 0, progress: "" },
    history: [],
  })),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  const base = await coreMock(importOriginal);
  const actual = await importOriginal<typeof CoreModule>();
  const config = base.getAgentConfig() as Record<string, unknown>;
  return {
    ...base,
    runWithContext: actual.runWithContext,
    getContext: actual.getContext,
    getAgentConfig: () => config,
  };
});

/** What provider prepared for the call, as the turn must hand it on. */
const PREPARED = { "test-upstream": { reasoning: { effort: "high" } } };
const prepare = vi.hoisted(() => vi.fn());

vi.mock("@breatic/domain", async (importOriginal) => {
  const { domainMock } = await import("../helpers/mock-core.js");
  const base = await domainMock();
  const actual = await importOriginal<typeof DomainModule>();
  const { modelProducing } = await import("../helpers/model-double.js");
  return {
    ...base,
    streamTextRetry: actual.streamTextRetry,
    buildAgentConfig: () => ({
      modelId: runningOn.modelId,
      instructions: { base: "system" },
      tools: {},
    }),
    finalizeTurn: async () => [],
    provider: () => ({
      llm: {
        prepare: prepare.mockImplementation(() => {
          const model = modelProducing(() => saying("好的"));
          runningOn.model = model;
          return { model, options: { providerOptions: PREPARED, maxRetries: 0 }, system: () => [], pendingCosts: () => [] };
        }),
        costOf: () => ({ state: "missing", reason: "test" }),
        servedBy: () => "test-upstream",
      },
    }),
  };
});

vi.mock("@server/modules/conversation/conversation-message.repo.js", () => ({
  addMessage: vi.fn(async () => 1),
  addUserMessage: vi.fn(async () => ({ turnIndex: 1, closedAsks: [] })),
  getMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
}));

vi.mock("@server/modules/conversation/conversation.service.js", () => ({
  getMessagesForLlm: async () => [],
  titleForTurn: vi.fn(async () => "一条会话"),
}));

vi.mock("@server/agent/turn-fold.js", () => ({
  foldIfTooLong: vi.fn(async () => "none"),
}));

vi.mock("@server/agent/context.js", () => ({
  buildSystemPrompt: () => "系统提示词",
}));

/** The part of the model call these cases read. */
interface SentCall {
  providerOptions?: Record<string, Record<string, unknown>>;
  temperature?: number;
}

/**
 * Run one turn and report the call the model was given.
 * @param modelId - What the turn runs on.
 * @returns The first call the model received, or undefined when there was none.
 */
async function callFor(modelId: string): Promise<SentCall | undefined> {
  runningOn.modelId = modelId;

  const { MainAgent } = await import("@server/agent/main-agent.js");
  const { runWithContext } = await import("@breatic/core");
  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    const turn = await new MainAgent().chat("说点什么");
    for await (const _chunk of turn) {
      // Drained rather than read: what this asserts on is the call that was
      // made, not what came back from it.
    }
  });

  return runningOn.model?.doStreamCalls[0];
}

describe("a turn that asks for the model's working", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asks provider for the working, the cache and the conversation's session", async () => {
    await callFor("deepseek/deepseek-v4-pro");
    expect(prepare).toHaveBeenCalledWith(
      "deepseek/deepseek-v4-pro",
      expect.objectContaining({ thinking: true, session: "c1" }),
      undefined,
    );
  });

  it("puts what provider prepared on the call the model receives", async () => {
    const call = await callFor("deepseek/deepseek-v4-pro");
    expect(call?.providerOptions).toMatchObject(PREPARED);
  });

  // With reasoning on, DeepSeek and Anthropic drop a temperature and say so,
  // OpenAI's reasoning models reject it, and Google asks that Gemini 3 be left
  // at its default of 1.0. There is no route where one set here takes effect.
  it("leaves the temperature to the model", async () => {
    const call = await callFor("google/gemini-2.5-pro");
    expect(call).toBeDefined();
    expect(call?.temperature).toBeUndefined();
  });
});
