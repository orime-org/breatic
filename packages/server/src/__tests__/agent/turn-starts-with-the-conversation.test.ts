// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Every turn begins by saying what the conversation actually holds.
 *
 * A stream is one-directional and a connection can go at any moment, so
 * neither side can promise the two views match. What can be promised is that
 * they are made to match again at a moment the reader is already waiting
 * through: they pressed send, the server stored what they said, and before
 * the model is asked anything the whole conversation goes back down the wire.
 *
 * So each turn settles up for the one before it, and the reader never has to
 * do anything about a reply that stopped arriving — their next message clears
 * it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as CoreModule from "@breatic/core";
import { SSE_EVENT_NAMES } from "@breatic/shared";

const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>) => 7);
const getMessages = vi.fn(async () => ({
  messages: [
    {
      id: "stored-1",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "what the server has" }],
      content: "what the server has",
      ts: "2026-08-14T00:00:00Z",
      turnIndex: 7,
    },
  ],
  hasMore: true,
}));
const consolidateIfNeeded = vi.fn(async () => undefined);
const streamTextRetry = vi.fn();

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
  getMessages,
}));
vi.mock("@server/agent/memory-consolidator.js", () => ({ consolidateIfNeeded }));
vi.mock("@server/agent/context.js", () => ({ buildSystemPrompt: () => "system" }));

const { MainAgent } = await import("@server/agent/main-agent.js");
const { runWithContext } = await import("@breatic/core");

/**
 * Run one turn and collect what it sent out, in order.
 * @returns Every SSE event the turn raised.
 */
async function eventsFromOneTurn(): Promise<Array<{ event: string; data: unknown }>> {
  streamTextRetry.mockReturnValue({
    fullStream: (async function* () {
      yield { type: "text-delta", text: "the reply" };
      yield { type: "finish-step", usage: { totalTokens: 10 } };
    })(),
    text: Promise.resolve("the reply"),
    totalUsage: Promise.resolve({ totalTokens: 10 }),
  });

  const raised: Array<{ event: string; data: unknown }> = [];
  await runWithContext(
    {
      userId: "u1",
      conversationId: "c1",
      projectId: "p1",
      memoryContext: { userMemory: "", projectMemory: "", conversationMemory: "" },
      compressedHistory: [],
    },
    async () => {
      for await (const event of new MainAgent().chat("a new question")) raised.push(event);
    },
  );
  return raised;
}

describe("a turn that begins by settling up", () => {
  beforeEach(() => {
    streamTextRetry.mockClear();
    addMessage.mockClear();
    getMessages.mockClear();
  });

  it("is a name both sides know", () => {
    // The browser reads event names from this one list. A name only the
    // server knows is a message nobody is listening for.
    expect(Object.values(SSE_EVENT_NAMES)).toContain("chat_turn_started");
  });

  it("sends the conversation before it sends a word of the reply", async () => {
    const raised = await eventsFromOneTurn();

    const first = raised[0];
    expect(first?.event).toBe(SSE_EVENT_NAMES.CHAT_TURN_STARTED);
    // The whole page, the same one opening the conversation hands out: the
    // browser replaces what it is holding with this, so a partial answer
    // would be worse than none.
    expect(first?.data).toEqual({
      messages: [
        expect.objectContaining({ id: "stored-1", content: "what the server has" }),
      ],
      hasMore: true,
    });
  });

  it("reads the conversation only after storing what the user said", async () => {
    await eventsFromOneTurn();

    // The other way round would send back a conversation without the message
    // this very turn is about, and the browser — which replaces what it holds
    // — would take the reader's own words off the screen.
    expect(addMessage).toHaveBeenCalledTimes(1);
    expect(getMessages).toHaveBeenCalledTimes(1);
    expect(addMessage.mock.invocationCallOrder[0]).toBeLessThan(
      getMessages.mock.invocationCallOrder[0]!,
    );
  });
});
