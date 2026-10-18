// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a turn sends as its system prompt, for a model that caches only where
 * it is told to.
 *
 * The base prompt, which every conversation shares, and the project's memory,
 * which one user's conversations in the project share, each end in a cache mark of
 * their own, so a new conversation's first call reads what an earlier
 * conversation in the same request locale wrote; this conversation's memory
 * follows unmarked.
 */
import { describe, expect, it, vi } from "vitest";
import type * as CoreModule from "@breatic/core";
import { saying } from "../helpers/model-double.js";
import type { ModelStreamPart } from "../helpers/model-double.js";

const modelSays = vi.hoisted(() => ({ parts: [] as unknown[], prompts: [] as unknown[] }));

vi.mock("@server/agent/turn-context.js", () => ({
  buildTurnContext: vi.fn(async () => ({
    memoryContext: { projectMemory: "", conversationMemory: "" },
    history: [],
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
    streamTextRetry: actual.streamTextRetry,
    systemFor: actual.systemFor,
    instructionsText: actual.instructionsText,
    buildAgentConfig: () => ({
      modelId: "anthropic/claude-opus-5.5",
      instructions: { base: "persona", project: "## Project Context\np", conversation: "## Conversation Memory\nc" },
      tools: {},
    }),
    finalizeTurn: async () => [],
    getModel: () =>
      modelProducing(
        () => modelSays.parts as ModelStreamPart[],
        (asked) => modelSays.prompts.push(asked.prompt),
      ),
  };
});

vi.mock("@server/modules/conversation/conversation-message.repo.js", () => ({
  addMessage: vi.fn(async () => 7),
  addReaderMessage: vi.fn(async () => ({ turnIndex: 7, closedAsks: [] })),
  getMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
}));
vi.mock("@server/modules/conversation/conversation.service.js", () => ({
  titleForTurn: vi.fn(async () => null),
}));
vi.mock("@server/agent/turn-budget.js", () => ({ foldIfOverBudget: vi.fn(async () => false) }));

const { MainAgent } = await import("@server/agent/main-agent.js");
const { runWithContext } = await import("@breatic/core");

describe("the system prompt a turn sends", () => {
  it("marks the base prompt and the project's memory and leaves this conversation's memory unmarked", async () => {
    modelSays.parts = saying("the reply");
    await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
      const turn = await new MainAgent().chat("hello", undefined, [], "UTC");
      for await (const _chunk of turn) void _chunk;
    });

    const prompt = modelSays.prompts.at(-1) as Array<{ role: string; content: unknown; providerOptions?: unknown }>;
    const system = prompt.filter((m) => m.role === "system");
    expect(system.map((m) => m.content)).toEqual(["persona", "## Project Context\np", "## Conversation Memory\nc"]);
    expect(system[0]!.providerOptions).toMatchObject({ openrouter: { cacheControl: { type: "ephemeral" } } });
    expect(system[1]!.providerOptions).toMatchObject({ openrouter: { cacheControl: { type: "ephemeral" } } });
    expect(system[2]!.providerOptions).toBeUndefined();
  });
});
