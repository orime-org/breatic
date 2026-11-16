// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A turn runs on the model the route resolved from the user's pick (#1363),
 * and its reply records that model, which a segment resumed by an answer to
 * its card runs on too.
 */
import { describe, it, expect, vi } from "vitest";
import type * as CoreModule from "@breatic/core";
import { FINISHED } from "../helpers/model-double.js";

const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>) => 1);
const buildAgentConfig = vi.fn(async (request: { modelId?: string }) => ({
  modelId: request.modelId ?? "the-default",
  instructions: { base: "system" },
  tools: {},
}));
// Writes the reply the way the real one does, so what the row is written
// with can be read off the store's double.
const finalizeTurn = vi.fn(async (input: { steps: { persist: () => Promise<void> } }) => {
  await input.steps.persist();
  return [];
});

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

vi.mock("@breatic/domain", async (importOriginal) => {
  const { domainMock } = await import("../helpers/mock-core.js");
  const base = await domainMock();
  const actual = await importOriginal<Record<string, unknown>>();
  const { modelProducing } = await import("../helpers/model-double.js");
  return {
    ...base,
    streamTextRetry: actual.streamTextRetry,
    buildAgentConfig,
    finalizeTurn,
    provider: (await import("../helpers/fake-provider.js")).fakeProvider(() =>
      modelProducing(() => [
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Done." },
        { type: "text-end", id: "t1" },
        FINISHED,
      ])),
  };
});

vi.mock("@server/modules/conversation/conversation-message.repo.js", () => ({
  addMessage,
  addUserMessage: async (id: string, msg: Record<string, unknown>) => ({ turnIndex: await addMessage(id, msg), closedAsks: [] }),
  getMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
}));
vi.mock("@server/modules/conversation/conversation.service.js", () => ({
  getMessagesForLlm: async () => [],
  titleForTurn: vi.fn(async () => "already named"),
}));
vi.mock("@server/agent/turn-fold.js", () => ({ foldIfTooLong: vi.fn(async () => "none") }));
vi.mock("@server/agent/context.js", () => ({ buildSystemPrompt: () => "system" }));

const { MainAgent } = await import("@server/agent/main-agent.js");
const { runWithContext } = await import("@breatic/core");

describe("a turn and the model the user picked", () => {
  it("is assembled on that model and records it in its reply", async () => {
    await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
      const turn = await new MainAgent().chat("hello", undefined, [], undefined, {}, "anthropic/claude-opus-5.5");
      for await (const _chunk of turn) {
        // read to the end
      }
    });

    expect(buildAgentConfig).toHaveBeenCalledWith(expect.objectContaining({ modelId: "anthropic/claude-opus-5.5" }));
    const reply = addMessage.mock.calls.find((call) => call[1].role === "assistant") as unknown[] | undefined;
    expect(reply?.[2]).toMatchObject({ modelId: "anthropic/claude-opus-5.5" });
  });
});
