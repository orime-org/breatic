// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Asking for the model's working is asked for differently per provider.
 *
 * The request currently names Anthropic outright: `providerOptions.anthropic
 * .thinking`. That is not a setting the other providers ignore politely --
 * it is a key addressed to one of them, and every other model gets asked for
 * nothing while the switch that turns it on still reads as though it worked.
 *
 * Which key to use follows from which provider instance is being called, and
 * that is not the same as which company serves the model. Our OpenRouter
 * provider is `createOpenAI` pointed at OpenRouter's endpoint, and
 * `createOpenAI` without a name is called `openai` -- so its options live
 * under `providerOptions.openai`, whatever the model id says. (`@ai-sdk/openai`
 * `index.js:10037` for the default name, `:1642` for how the key is derived.)
 * `resolveProvider()` answers a different question -- which company to record
 * a charge against -- and returns "openrouter" here. The two must not be
 * confused.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as CoreModule from "@breatic/core";
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
  thinking: true,
  model: undefined as MockLanguageModelV4 | undefined,
}));

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
  const config = base.getAgentConfig() as Record<string, unknown>;
  return {
    ...base,
    runWithContext: actual.runWithContext,
    getContext: actual.getContext,
    getAgentConfig: () => ({ ...config, thinking_enabled: runningOn.thinking }),
  };
});

vi.mock("@breatic/domain", async (importOriginal) => {
  const { domainMock } = await import("../helpers/mock-core.js");
  const base = await domainMock();
  const actual = await importOriginal<Record<string, unknown>>();
  const { modelProducing } = await import("../helpers/model-double.js");
  return {
    ...base,
    streamTextRetry: actual.streamTextRetry,
    buildAgentConfig: () => ({
      modelId: runningOn.modelId,
      instructions: "system",
      tools: {},
    }),
    finalizeTurn: async () => [],
    getModel: () => {
      const model = modelProducing(() => saying("好的"));
      runningOn.model = model;
      return model;
    },
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
 * Run one turn and report the provider options the model call was given.
 * @param modelId - What the turn runs on.
 * @param thinking - Whether the config asks for the model's working.
 * @returns The `providerOptions` argument, or undefined when there was none.
 */
async function providerOptionsFor(
  modelId: string,
  thinking: boolean,
): Promise<Record<string, Record<string, unknown>> | undefined> {
  runningOn.modelId = modelId;
  runningOn.thinking = thinking;

  const { MainAgent } = await import("@server/agent/main-agent.js");
  const { runWithContext } = await import("@breatic/core");
  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    const turn = await new MainAgent().chat("说点什么");
    for await (const _chunk of turn) {
      // Drained rather than read: what this asserts on is the call that was
      // made, not what came back from it.
    }
  });

  const called = runningOn.model?.doStreamCalls[0];
  return called?.providerOptions;
}

describe("asking DeepSeek for its working", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the reasoning effort the OpenAI-compatible endpoint takes", async () => {
    const options = await providerOptionsFor("deepseek/deepseek-v4-pro", true);

    // `high` of the three levels the model offers -- Non-Think, Think High,
    // Think Max. A boolean switch has one level to map onto and this is the
    // middle one; the top is there for a setting that asks for it by name.
    // Whether the switch defaults on at all is decided by the measurement in
    // C3, not here.
    expect(options?.openai?.reasoningEffort).toBe("high");
  });

  it("does not address Anthropic when Anthropic is not who is being called", async () => {
    const options = await providerOptionsFor("deepseek/deepseek-v4-pro", true);
    expect(options?.anthropic).toBeUndefined();
  });
});

describe("asking Claude for its working", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("still asks the way Anthropic wants to be asked", async () => {
    // Green before the change as well as after: the point of it is that
    // splitting the request per provider does not drop the branch that
    // already worked. Both fields carry weight -- without `type` extended
    // thinking stays off, and on the adaptive tier the blocks arrive empty
    // unless the summary is asked for by name.
    const options = await providerOptionsFor("anthropic/claude-sonnet-4-6", true);
    expect(options?.anthropic?.thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    });
    expect(options?.openai).toBeUndefined();
  });
});

describe("when the working is not asked for", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends no reasoning options at all, whichever model it is", async () => {
    // Also green today. It says the switch still turns the whole thing off
    // once there are two branches to turn off rather than one.
    expect(await providerOptionsFor("deepseek/deepseek-v4-pro", false)).toBeUndefined();
    vi.clearAllMocks();
    expect(await providerOptionsFor("anthropic/claude-sonnet-4-6", false)).toBeUndefined();
  });
});
