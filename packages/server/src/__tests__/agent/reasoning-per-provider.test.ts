// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A chat turn asks for the model's working, and the ask reaches the model.
 *
 * Which vendor takes the request which way is settled in the routing table
 * and covered by its own tests; what is only observable from here is whether
 * the turn puts the answer on the call at all. A turn that worked it out and
 * dropped it looks identical from outside, and that is what used to happen:
 * the switch read as though it worked while the key it wrote was addressed
 * to a provider the OpenRouter instance never answered to.
 *
 * The model is a double so the options can be read off the call; the routing
 * and the translation are both real, because those are the parts that decide
 * what gets written.
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
  /** What this deployment has for an Anthropic key, if anything. */
  anthropicKey: undefined as string | undefined,
  /** And what it has for a Google key. */
  googleKey: undefined as string | undefined,
  model: undefined as MockLanguageModelV4 | undefined,
}));

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
  const config = base.getAgentConfig() as Record<string, unknown>;
  return {
    ...base,
    runWithContext: actual.runWithContext,
    getContext: actual.getContext,
    getAgentConfig: () => config,
    // Whether this deployment has an Anthropic key of its own is what decides
    // between calling Anthropic and reaching the same model through
    // OpenRouter -- and those two take the request differently. Per case, so
    // both deployments are covered.
    env: new Proxy(base.env, {
      get: (target, key) =>
        key === "ANTHROPIC_API_KEY"
          ? runningOn.anthropicKey
          : key === "GOOGLE_API_KEY"
            ? runningOn.googleKey
            : Reflect.get(target, key),
    }),
  };
});

vi.mock("@breatic/domain", async (importOriginal) => {
  const { domainMock } = await import("../helpers/mock-core.js");
  const base = await domainMock();
  const actual = await importOriginal<typeof DomainModule>();
  const { modelProducing } = await import("../helpers/model-double.js");
  return {
    ...base,
    streamTextRetry: actual.streamTextRetry,
    // The real one. What this file is about is which provider instance ends
    // up being called, and stubbing the function that decides that would
    // leave the question unasked.
    resolveProvider: actual.resolveProvider,
    // Real as well: what it returns is the thing under assertion.
    reasoningFor: actual.reasoningFor,
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

vi.mock("@server/agent/turn-budget.js", () => ({
  foldIfOverBudget: vi.fn(async () => false),
}));

vi.mock("@server/agent/context.js", () => ({
  buildSystemPrompt: () => "系统提示词",
}));

/**
 * Run one turn and report the provider options the model call was given.
 * @param modelId - What the turn runs on.
 * @param anthropicKey - What this deployment holds for Anthropic, if anything.
 * @param googleKey - And for Google.
 * @returns The `providerOptions` argument, or undefined when there was none.
 */
async function providerOptionsFor(
  modelId: string,
  anthropicKey?: string,
  googleKey?: string,
): Promise<Record<string, Record<string, unknown>> | undefined> {
  runningOn.modelId = modelId;
  runningOn.anthropicKey = anthropicKey;
  runningOn.googleKey = googleKey;

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

  it("addresses OpenRouter, which is who a deployment without the key reaches", async () => {
    // No DeepSeek key here, so the model id names a vendor this deployment
    // cannot reach directly and the call goes through the fallback. The key
    // has to name whoever is on the other end -- a request addressed to
    // anyone else is a switch that reads as working and asks for nothing.
    const options = await providerOptionsFor("deepseek/deepseek-v4-pro");
    expect(options?.openrouter?.reasoning).toEqual({ effort: "high" });
  });

  it("does not address Anthropic when Anthropic is not who is being called", async () => {
    const options = await providerOptionsFor("deepseek/deepseek-v4-pro");
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
    const options = await providerOptionsFor("anthropic/claude-sonnet-4-6", "sk-ant-test");
    expect(options?.anthropic?.thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    });
    expect(options?.openai).toBeUndefined();
  });

  it("addresses OpenRouter when the same model is reached through it", async () => {
    // Same model id, deployment without an Anthropic key of its own. The
    // call goes through the fallback then, so addressing Anthropic here
    // would be addressing a provider that is not on the other end.
    const options = await providerOptionsFor("anthropic/claude-sonnet-4-6");
    expect(options?.openrouter?.reasoning).toEqual({ effort: "high" });
    expect(options?.anthropic).toBeUndefined();
  });
});

describe("asking Gemini for its working", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asks the way Google takes it, not the OpenAI-compatible way", async () => {
    // A deployment with its own Google key calls Google directly, and Google
    // neither reads `openai` options nor takes a level -- it takes a budget,
    // plus a separate say-so for the thoughts themselves.
    const options = await providerOptionsFor("google/gemini-2.5-pro", undefined, "goog-test");
    expect(options?.google?.thinkingConfig).toEqual({
      thinkingBudget: -1,
      includeThoughts: true,
    });
    expect(options?.openai).toBeUndefined();
  });
});

