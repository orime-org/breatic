// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What a turn says before it has anything to say.
 *
 * A conversation takes its name from the first thing said in it, and that
 * settles before the model is asked anything -- so the name goes out right
 * after the frame that opens the reply, while the panel and the list are still showing a placeholder. Nothing else
 * on this stream would ever correct them.
 *
 * The other thing a turn used to open with was the whole stored conversation,
 * as a settling-up for anything an earlier dropped connection had left
 * mismatched. That is gone: the page reads the newest page of history before
 * it attaches to a run, and a connection that drops mid-reply is read again
 * and re-attached to, the run replaying from its start (inner#1717).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as CoreModule from "@breatic/core";
import { saying } from "../helpers/model-double.js";
import type { ModelStreamPart } from "../helpers/model-double.js";

const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>) => 7);
const foldIfTooLong = vi.fn(async () => "none");

/** What the model produces this case. */
const modelSays = vi.hoisted(() => ({ parts: [] as unknown[] }));

const buildTurnContext = vi.fn(async () => ({
  memoryContext: { entries: [], migrated: [], olderCount: 0, progress: "" },
  history: [],
}));

vi.mock("@server/agent/turn-context.js", () => ({ buildTurnContext }));

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
    buildAgentConfig: () => ({ modelId: "test", instructions: { base: "system" }, tools: {} }),
    finalizeTurn: async () => [],
    getModel: () => modelProducing(() => modelSays.parts as ModelStreamPart[]),
  };
});

vi.mock("@server/modules/conversation/conversation-message.repo.js", () => ({
  addMessage,
  addUserMessage: async (id: string, msg: Record<string, unknown>) => ({ turnIndex: await addMessage(id, msg), closedAsks: [] }),
  getMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
}));

// The turn asks the conversation what it is called. Answered with a name it
// did not have before, which is the case that has anything to send.
vi.mock("@server/modules/conversation/conversation.service.js", () => ({
  getMessagesForLlm: async () => [],
  titleForTurn: vi.fn(async () => "已经有名字了"),
}));

vi.mock("@server/agent/turn-fold.js", () => ({ foldIfTooLong }));
vi.mock("@server/agent/context.js", () => ({ buildSystemPrompt: () => "system" }));

const { MainAgent } = await import("@server/agent/main-agent.js");
const { runWithContext } = await import("@breatic/core");

/**
 * Run one turn and collect what went on the wire.
 * @returns Every chunk the turn put out, in order.
 */
async function chunksFromOneTurn(): Promise<Array<Record<string, unknown>>> {
  modelSays.parts = saying("the reply");

  const seen: Array<Record<string, unknown>> = [];
  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    const turn = await new MainAgent().chat("a new question");
    for await (const chunk of turn) seen.push(chunk);
  });
  return seen;
}

describe("the name a turn gives its conversation", () => {
  beforeEach(() => {
    addMessage.mockClear();
    buildTurnContext.mockClear();
  });

  it("goes out before a word of the reply", async () => {
    const chunks = await chunksFromOneTurn();

    // Right after the reply is named, and ahead of the model's own stream: the
    // list and the header are showing a placeholder right now, and this is
    // the only thing that corrects them.
    expect(chunks[0]?.type).toBe("start");
    expect(chunks[1]).toEqual({
      type: "data-conversation-titled",
      data: { title: "已经有名字了" },
    });
  });

  it("is settled after the message is stored, never before", async () => {
    await chunksFromOneTurn();

    // A conversation is named after the first thing said in it, so the thing
    // said has to be on record before there is anything to name it after.
    // One call and not two: what the assistant said back is written by the
    // finalizer, which this file replaces.
    expect(addMessage).toHaveBeenCalledTimes(1);
    expect(addMessage.mock.calls[0]?.[1]).toMatchObject({ role: "user" });
  });

  it("does not wait for the slow work before saying it", async () => {
    modelSays.parts = saying("the reply");

    // Held open, so that anything waiting on it waits forever. Three round
    // trips -- the memories, the conversation and its history -- and every
    // one of them is time the user spends in front of a screen where
    // nothing has happened.
    let releaseTheSlowWork = (): void => undefined;
    buildTurnContext.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseTheSlowWork = (): void => {
            resolve({
              memoryContext: { entries: [], migrated: [], olderCount: 0, progress: "" },
              history: [],
            });
          };
        }),
    );

    await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
      const turn = await new MainAgent().chat("a new question");
      // Read one chunk rather than draining: what is being watched is what
      // gets out while the work above is still unfinished, and a drained turn
      // would say nothing about it.
      const reader = turn.getReader();
      expect(((await reader.read()).value as { type: string }).type).toBe("start");
      expect(((await reader.read()).value as { type: string }).type).toBe("data-conversation-titled");

      releaseTheSlowWork();
      await reader.cancel();
    });
  });
});
