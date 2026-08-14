// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The model's thinking, on its way to the screen.
 *
 * Everything this needed was already built — the loop had a case for it, the
 * store had a part for it, the panel had a foldable block for it — except the
 * two ends: nobody turned the model's thinking on, and nothing sent it out.
 *
 * Both are load-bearing and neither shows up as a failure. With thinking off
 * the provider emits no reasoning at all, so a loop that forwards it perfectly
 * forwards nothing; and with it on but nothing forwarding, the thinking is
 * stored and never seen.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as CoreModule from "@breatic/core";
import { SSE_EVENT_NAMES } from "@breatic/shared";

const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>) => 1);
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

/**
 * What the conversation holds, for the settle-up every turn opens with.
 *
 * Empty because these cases are about what happens after that: the point of
 * the event is that the browser takes the server's version, and a version
 * with nothing in it is the version that gets out of the way.
 */
const getMessages = vi.fn(async () => ({ messages: [], hasMore: false }));

vi.mock("@server/modules/conversation/conversation-message.repo.js", () => ({ addMessage, getMessages }));
vi.mock("@server/agent/memory-consolidator.js", () => ({ consolidateIfNeeded }));
vi.mock("@server/agent/context.js", () => ({ buildSystemPrompt: () => "system" }));

const { MainAgent } = await import("@server/agent/main-agent.js");
const { runWithContext } = await import("@breatic/core");

/**
 * Run one turn over the given stream and collect what it sent out.
 * @param parts - The parts the model's stream produces
 * @returns Every SSE event the turn raised, in order
 */
async function eventsFrom(parts: unknown[]): Promise<Array<{ event: string; data: unknown }>> {
  streamTextRetry.mockReturnValue({
    fullStream: (async function* () {
      for (const part of parts) yield part;
    })(),
    text: Promise.resolve(""),
    totalUsage: Promise.resolve({ totalTokens: 0 }),
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
      // The turn yields events as objects; turning them into wire frames is
      // the route's job, further out.
      for await (const event of new MainAgent().chat("think about this")) {
        raised.push(event);
      }
    },
  );
  return raised;
}

describe("the model's thinking on the wire", () => {
  beforeEach(() => {
    streamTextRetry.mockClear();
    addMessage.mockClear();
  });

  it("is a name both sides know", () => {
    // The frontend reads event names from this one list. A name only the
    // backend knows is a message nobody is listening for.
    expect(Object.values(SSE_EVENT_NAMES)).toContain("agent_thinking");
  });

  it("goes out as it arrives, not only into the store", async () => {
    const raised = await eventsFrom([
      { type: "reasoning-delta", id: "r1", text: "first I need to" },
      { type: "reasoning-delta", id: "r1", text: " check something" },
      { type: "text-delta", text: "Here is the answer." },
      { type: "finish-step", usage: { totalTokens: 100 } },
    ]);

    const thinking = raised.filter((e) => e.event === "agent_thinking");
    expect(thinking.map((e) => (e.data as { text: string }).text)).toEqual([
      "first I need to",
      " check something",
    ]);
  });

  it("says which block each piece belongs to, so two thoughts do not merge", async () => {
    const raised = await eventsFrom([
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", text: "one" },
      { type: "reasoning-end", id: "r1" },
      { type: "reasoning-start", id: "r2" },
      { type: "reasoning-delta", id: "r2", text: "two" },
      { type: "finish-step", usage: { totalTokens: 100 } },
    ]);

    const thinking = raised.filter((e) => e.event === "agent_thinking");
    expect(thinking.map((e) => (e.data as { blockId: string }).blockId)).toEqual(["r1", "r2"]);
  });

  it("keeps quiet when the provider sends an empty piece", async () => {
    // `@ai-sdk/anthropic` raises a reasoning-delta with no text when it
    // forwards the block's signature. Sending that on is a stream of empty
    // events the panel would have to learn to ignore.
    const raised = await eventsFrom([
      { type: "reasoning-delta", id: "r1", text: "" },
      { type: "finish-step", usage: { totalTokens: 100 } },
    ]);

    expect(raised.filter((e) => e.event === "agent_thinking")).toHaveLength(0);
  });

  it("asks the provider for thinking it can actually read", async () => {
    await eventsFrom([{ type: "finish-step", usage: { totalTokens: 10 } }]);

    const sent = streamTextRetry.mock.calls[0]?.[0] as
      | { providerOptions?: { anthropic?: Record<string, unknown> } }
      | undefined;

    // Off by default at the provider, and on with the summary omitted the
    // blocks come through with empty text — so both fields carry weight.
    expect(sent?.providerOptions?.anthropic?.thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    });
  });
});
