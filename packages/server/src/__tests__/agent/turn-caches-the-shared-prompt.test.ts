// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What a turn sends as its system prompt, for a model that caches only where
 * it is told to.
 *
 * The base prompt, which every conversation shares, and the memory entries,
 * which one user's conversations in the project share while their entries
 * read the same, each end in a cache mark of their own, so a new
 * conversation's first call reads what an earlier conversation in the same
 * request locale wrote; this conversation's progress note follows unmarked.
 */
import { describe, expect, it, vi } from "vitest";
import type * as CoreModule from "@breatic/core";
import { saying } from "../helpers/model-double.js";
import type { ModelStreamPart } from "../helpers/model-double.js";

const modelSays = vi.hoisted(() => ({ parts: [] as unknown[], prompts: [] as unknown[] }));

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
  return { ...base, runWithContext: actual.runWithContext, getContext: actual.getContext };
});

const MARK = vi.hoisted(() => ({ "test-upstream": { cacheControl: { type: "ephemeral" } } }));

vi.mock("@breatic/domain", async (importOriginal) => {
  const { domainMock } = await import("../helpers/mock-core.js");
  const base = await domainMock();
  const actual = await importOriginal<Record<string, unknown>>();
  const { modelProducing } = await import("../helpers/model-double.js");
  return {
    ...base,
    streamTextRetry: actual.streamTextRetry,
    instructionsText: actual.instructionsText,
    buildAgentConfig: () => ({
      modelId: "anthropic/claude-opus-5.5",
      instructions: { base: "persona", project: "## Project Context\np", conversation: "## Conversation Memory\nc" },
      tools: {},
    }),
    finalizeTurn: async () => [],
    provider: (await import("../helpers/fake-provider.js")).fakeProvider(() =>
      modelProducing(
        () => modelSays.parts as ModelStreamPart[],
        (asked) => modelSays.prompts.push(asked.prompt),
      ),
      // Marked the way a caching upstream is marked; which parts provider marks is its own, and its tests hold it.
      (parts) => [
        { role: "system", content: parts.base, providerOptions: MARK },
        ...(parts.project === undefined ? [] : [{ role: "system", content: parts.project, providerOptions: MARK }]),
        ...(parts.conversation === undefined ? [] : [{ role: "system", content: parts.conversation }]),
      ]),
  };
});

vi.mock("@server/modules/conversation/conversation-message.repo.js", () => ({
  addMessage: vi.fn(async () => 7),
  addUserMessage: vi.fn(async () => ({ turnIndex: 7, closedAsks: [] })),
  getMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
}));
vi.mock("@server/modules/conversation/conversation.service.js", () => ({
  getMessagesForLlm: async () => [],
  titleForTurn: vi.fn(async () => null),
}));
vi.mock("@server/agent/turn-fold.js", () => ({ foldIfTooLong: vi.fn(async () => "none") }));

const { MainAgent } = await import("@server/agent/main-agent.js");
const { runWithContext } = await import("@breatic/core");

describe("the system prompt a turn sends", () => {
  it("sends the system prompt as provider laid it out for the turn's instructions", async () => {
    modelSays.parts = saying("the reply");
    await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
      const turn = await new MainAgent().chat("hello", undefined, [], "UTC");
      for await (const _chunk of turn) void _chunk;
    });

    const prompt = modelSays.prompts.at(-1) as Array<{ role: string; content: unknown; providerOptions?: unknown }>;
    const system = prompt.filter((m) => m.role === "system");
    expect(system.map((m) => m.content)).toEqual(["persona", "## Project Context\np", "## Conversation Memory\nc"]);
    expect(system[0]!.providerOptions).toMatchObject(MARK);
    expect(system[1]!.providerOptions).toMatchObject(MARK);
    expect(system[2]!.providerOptions).toBeUndefined();
  });
});
