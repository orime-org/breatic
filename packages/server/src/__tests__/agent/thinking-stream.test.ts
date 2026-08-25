// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The model's thinking, on its way to the screen.
 *
 * Two things had to be true for any of it to arrive, and neither shows up as
 * a failure: the provider has to be asked for thinking at all, and what it
 * sends has to be forwarded. With thinking off the provider emits no
 * reasoning, so a turn that forwards it perfectly forwards nothing; with it
 * on but nothing forwarding, the thinking is stored and never seen.
 *
 * Only the second half is asserted here. Which provider option asks for it is
 * a question of who is being called, and `reasoning-per-provider.test.ts`
 * answers it for all three -- asserting it a second time here would be a copy
 * that covers one of them and goes stale on its own.
 *
 * Forwarding is no longer code of ours: the protocol carries reasoning the
 * same way it carries text, so what these cases really check is that the
 * turn puts the model's own stream on the wire rather than a reading of it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as CoreModule from "@breatic/core";
import { FINISHED } from "../helpers/model-double.js";
import type { ModelStreamPart } from "../helpers/model-double.js";

const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>) => 1);
const consolidateIfNeeded = vi.fn(async () => undefined);

/** What the model produces this case. */
const modelSays = vi.hoisted(() => ({ parts: [] as ModelStreamPart[] }));

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
  return { ...base, runWithContext: actual.runWithContext, getContext: actual.getContext };
});

// The model is the double, not the call around it: what is being checked is
// what happens to the model's output on its way out, and replacing the call
// would replace exactly that.
vi.mock("@breatic/domain", async (importOriginal) => {
  const { domainMock } = await import("../helpers/mock-core.js");
  const base = await domainMock();
  const actual = await importOriginal<Record<string, unknown>>();
  const { modelProducing } = await import("../helpers/model-double.js");
  return {
    ...base,
    streamTextRetry: actual.streamTextRetry,
    buildAgentConfig: () => ({ modelId: "test", instructions: "system", tools: {} }),
    finalizeTurn: async () => [],
    getModel: () => modelProducing(() => modelSays.parts),
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

vi.mock("@server/modules/conversation/conversation-message.repo.js", () => ({
  addMessage,
  getMessages,
}));
// The turn asks the conversation what it is called, so it can say so in the
// event that opens the turn. Answered with a name already set: these tests are
// about what a turn streams, not about how a conversation comes by its name.
vi.mock("@server/modules/conversation/conversation.service.js", () => ({
  titleForTurn: vi.fn(async () => "already named"),
}));

vi.mock("@server/agent/memory-consolidator.js", () => ({ consolidateIfNeeded }));
vi.mock("@server/agent/context.js", () => ({ buildSystemPrompt: () => "system" }));

const { MainAgent } = await import("@server/agent/main-agent.js");
const { runWithContext } = await import("@breatic/core");


/**
 * Run one turn over the given model output and collect what went on the wire.
 * @param parts - The parts the model's stream produces.
 * @returns Every chunk the turn put out, in order.
 */
async function chunksFrom(
  parts: ModelStreamPart[],
): Promise<Array<Record<string, unknown>>> {
  modelSays.parts = [...parts, FINISHED];

  const seen: Array<Record<string, unknown>> = [];
  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    const turn = await new MainAgent().chat("think about this");
    for await (const chunk of turn) {
      seen.push(chunk);
    }
  });
  return seen;
}

describe("the model's thinking on the wire", () => {
  beforeEach(() => {
    addMessage.mockClear();
  });

  it("goes out as it arrives, not only into the store", async () => {
    const chunks = await chunksFrom([
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", delta: "first I need to" },
      { type: "reasoning-delta", id: "r1", delta: " check something" },
      { type: "reasoning-end", id: "r1" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Here is the answer." },
      { type: "text-end", id: "t1" },
    ]);

    const thinking = chunks.filter((c) => c.type === "reasoning-delta");
    expect(thinking.map((c) => c.delta)).toEqual(["first I need to", " check something"]);
  });

  it("says which block each piece belongs to, so two thoughts do not merge", async () => {
    const chunks = await chunksFrom([
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", delta: "one" },
      { type: "reasoning-end", id: "r1" },
      { type: "reasoning-start", id: "r2" },
      { type: "reasoning-delta", id: "r2", delta: "two" },
      { type: "reasoning-end", id: "r2" },
    ]);

    // Two blocks, told apart by the id they carry -- without it the panel
    // has one long thought where the model had two.
    expect(chunks.filter((c) => c.type === "reasoning-start").map((c) => c.id)).toEqual([
      "r1",
      "r2",
    ]);
    expect(chunks.filter((c) => c.type === "reasoning-delta").map((c) => c.id)).toEqual([
      "r1",
      "r2",
    ]);
  });

  it("sends thinking apart from prose, so the panel can fold one and not the other", async () => {
    const chunks = await chunksFrom([
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", delta: "working it out" },
      { type: "reasoning-end", id: "r1" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "the answer" },
      { type: "text-end", id: "t1" },
    ]);

    // Both on the wire and neither wearing the other's type. A turn that sent
    // reasoning as text would read as an assistant thinking out loud at the
    // reader, with nothing to fold away.
    expect(chunks.find((c) => c.type === "reasoning-delta")?.delta).toBe("working it out");
    expect(chunks.find((c) => c.type === "text-delta")?.delta).toBe("the answer");
  });
});
