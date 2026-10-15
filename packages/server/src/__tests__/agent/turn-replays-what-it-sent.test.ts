// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A turn sends the history as it was sent, and keeps its own message as sent
 * (inner#1549).
 *
 * The provider reads its cached prefix back only when the next request starts
 * with the same bytes, so what goes out is what was stored of each earlier
 * message, thinking included while everything before a reply is what its turn
 * sent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import type * as CoreModule from "@breatic/core";
import type { MessageData } from "@breatic/shared";
import { prefixHash, type RequestPrefix } from "@server/agent/history-replay.js";
import { FAILED_NOTE } from "@server/agent/model-messages.js";
import { UNCHANGED_SPACE_NOTE, openSpaceKey } from "@server/agent/user-turn.js";
import { measureMessages } from "@server/agent/payload-size.js";
import { saying } from "../helpers/model-double.js";
import type { ModelStreamPart } from "../helpers/model-double.js";

const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>, _forModel?: unknown) => 7);
const setUserForModel = vi.fn(async (_id: string, _turn: number, _forModel: unknown) => undefined);
const modelSays = vi.hoisted(() => ({
  parts: [] as unknown[],
  prompts: [] as unknown[],
  history: [] as Array<MessageData & { forModel: unknown }>,
}));

vi.mock("@server/agent/turn-context.js", () => ({
  // The running turn is not its own history, as the real read leaves it out.
  buildTurnContext: vi.fn(async (_u: string, _c: string, _p: string, runningTurn: number) => ({
    memoryContext: { projectMemory: "", conversationMemory: "" },
    history: modelSays.history.filter((row) => row.turnIndex < runningTurn),
    watermark: 0,
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
    buildAgentConfig: () => ({ modelId: "test", instructions: "system", tools: {} }),
    // The real one, so the reply is written down.
    finalizeTurn: actual.finalizeTurn,
    getModel: () =>
      modelProducing(
        () => modelSays.parts as ModelStreamPart[],
        (asked) => modelSays.prompts.push(asked.prompt),
      ),
  };
});

vi.mock("@server/modules/conversation/conversation-message.repo.js", () => ({
  addMessage,
  setUserForModel,
  getMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
}));
vi.mock("@server/modules/conversation/conversation.service.js", () => ({
  titleForTurn: vi.fn(async () => null),
}));
vi.mock("@server/agent/turn-budget.js", () => ({ foldIfOverBudget: vi.fn(async () => false) }));

const { MainAgent } = await import("@server/agent/main-agent.js");
const { runWithContext, logger } = await import("@breatic/core");

/** What the mocked factory resolves every turn to. */
const PREFIX: RequestPrefix = { system: "system", tools: {}, modelId: "test" };

const ASKED: ModelMessage = { role: "user", content: "earlier question, as sent" };
const ANSWERED: ModelMessage[] = [
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "Working it out.", providerOptions: { anthropic: { signature: "sig" } } },
      { type: "text", text: "Earlier answer." },
    ],
  },
];

/**
 * The stored history of one earlier turn.
 * @param replyPrefix - What the reply's turn sent ahead of it.
 * @returns The rows as the repository hands them out.
 */
function earlierTurn(replyPrefix: RequestPrefix = PREFIX): Array<MessageData & { forModel: unknown }> {
  return [
    {
      role: "user",
      content: "earlier question",
      parts: [{ type: "text", text: "earlier question" }],
      ts: "",
      turnIndex: 6,
      forModel: { messages: [ASKED] },
    },
    {
      role: "assistant",
      content: "Earlier answer.",
      parts: [{ type: "text", text: "Earlier answer." }],
      ts: "",
      turnIndex: 6,
      forModel: { messages: ANSWERED, prefixHash: prefixHash(replyPrefix, [ASKED]), turnTokens: 5, endTokens: 9 },
    },
  ];
}

/**
 * Run one turn to its end.
 * @param said - What the user typed.
 */
async function runOneTurn(said: string): Promise<void> {
  modelSays.parts = saying("the reply");
  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    const turn = await new MainAgent().chat(said, undefined, [], "UTC");
    for await (const _chunk of turn) void _chunk;
  });
}

/**
 * The provider-level prompt of the model's first call, as text.
 * @returns The prompt, serialised.
 */
function firstPromptText(): string {
  return JSON.stringify(modelSays.prompts[0]);
}

beforeEach(() => {
  addMessage.mockReset();
  addMessage.mockImplementation(async () => 7);
  setUserForModel.mockReset();
  setUserForModel.mockImplementation(async () => undefined);
  vi.mocked(logger.error).mockClear();
  modelSays.prompts = [];
  modelSays.history = [];
});

describe("a turn replays the history as it was sent", () => {
  it("sends an earlier user message as it was stored", async () => {
    modelSays.history = earlierTurn();

    await runOneTurn("next question");

    expect(firstPromptText()).toContain("earlier question, as sent");
  });

  it("sends an earlier reply's thinking back while everything before it is what its turn sent", async () => {
    modelSays.history = earlierTurn();

    await runOneTurn("next question");

    expect(firstPromptText()).toContain("Working it out.");
  });

  it("leaves an earlier reply's thinking out once what came before it changed", async () => {
    modelSays.history = earlierTurn({ ...PREFIX, system: "an older system prompt" });

    await runOneTurn("next question");

    expect(firstPromptText()).not.toContain("Working it out.");
    expect(firstPromptText()).toContain("Earlier answer.");
  });
});

describe("a turn keeps its own message as it was sent", () => {
  it("stores the message the model was sent, under this turn", async () => {
    await runOneTurn("next question");

    const sent = (modelSays.prompts[0] as Array<{ role: string }>).filter((m) => m.role === "user").at(-1);
    expect(setUserForModel).toHaveBeenCalledTimes(1);
    const [conversationId, turnIndex, kept] = setUserForModel.mock.calls[0] ?? [];
    expect(conversationId).toBe("c1");
    expect(turnIndex).toBe(7);
    const [message] = (kept as { messages: ModelMessage[] }).messages;
    expect(message?.role).toBe("user");
    expect(JSON.stringify(sent)).toContain(JSON.stringify(message?.content).slice(1, -1));
  });

  it("answers the reader even when keeping that copy fails, and says so in the log", async () => {
    setUserForModel.mockImplementation(async () => {
      throw new Error("database away");
    });

    await runOneTurn("next question");

    expect(modelSays.prompts).toHaveLength(1);
    expect(vi.mocked(logger.error).mock.calls.map((call) => call[1])).toContain("turn_user_for_model_write_failed");
  });
});

/**
 * What the turn kept of its reply as sent.
 * @returns The copy handed to the store with the reply.
 */
function keptReply(): { messages: ModelMessage[]; prefixHash: string; turnTokens: number; endTokens: number } {
  const call = addMessage.mock.calls.find((c) => (c[1] as { role: string }).role === "assistant");
  return call?.[2] as never;
}

/**
 * This turn's user message as it was sent.
 * @returns The message.
 */
function sentUserMessage(): ModelMessage {
  return (setUserForModel.mock.calls[0]?.[2] as { messages: ModelMessage[] }).messages[0] as ModelMessage;
}

describe("a turn keeps its reply as it was sent", () => {
  it("keeps the step it sent on, under the hash of the request that asked for it", async () => {
    modelSays.history = earlierTurn();

    await runOneTurn("next question");

    const kept = keptReply();
    expect(kept.messages).toEqual([{ role: "assistant", content: [{ type: "text", text: "the reply" }] }]);
    expect(kept.prefixHash).toBe(prefixHash(PREFIX, [ASKED, ...ANSWERED, sentUserMessage()]));
  });

  it("keeps how much the turn added and how big the conversation ended, from the provider's count", async () => {
    await runOneTurn("next question");

    // The double reports one input and one output token on its call.
    const kept = keptReply();
    expect(kept.endTokens).toBe(2);
    expect(kept.turnTokens).toBe(2 - 1 + measureMessages([sentUserMessage()]));
  });

  it("keeps a turn that broke off as a note saying so", async () => {
    modelSays.parts = [{ type: "error", error: new Error("provider connection dropped") }];
    await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
      const turn = await new MainAgent().chat("next question", undefined, [], "UTC");
      for await (const _chunk of turn) void _chunk;
    });

    expect(keptReply().messages.at(-1)).toEqual({ role: "assistant", content: FAILED_NOTE });
  });
});

describe("a turn sends the open Space once while it stays the same", () => {
  const canvas = { id: "s1", name: "Shots", kind: "canvas" as const };
  const content = '{"edges":[],"nodes":[{"id":"n1","name":"Hero"}]}';
  const open = { ...canvas, state: "loaded" as const, content, total_chars: content.length };

  /**
   * Run one turn with the Space open.
   * @param current - The Space as the reader has it.
   */
  async function runWithSpaceOpen(current: typeof open): Promise<void> {
    modelSays.parts = saying("the reply");
    await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
      const turn = await new MainAgent().chat("next question", undefined, [], "UTC", {
        spaces: [canvas],
        spaces_total: 1,
        current_space: current,
      });
      for await (const _chunk of turn) void _chunk;
    });
  }

  /** An earlier turn that sent this Space in full. */
  function sentBefore(): Array<MessageData & { forModel: unknown }> {
    return [
      {
        role: "user",
        content: "earlier",
        parts: [{ type: "text", text: "earlier" }],
        ts: "",
        turnIndex: 6,
        forModel: { messages: [ASKED], snapshot: { spaceId: "s1", key: openSpaceKey(open), full: true } },
      },
    ];
  }

  it("says it is unchanged when it is what was last sent in full", async () => {
    modelSays.history = sentBefore();

    await runWithSpaceOpen(open);

    const kept = setUserForModel.mock.calls[0]?.[2] as { messages: Array<{ content: string }>; snapshot: unknown };
    expect(kept.messages[0]?.content).toContain(UNCHANGED_SPACE_NOTE);
    expect(kept.messages[0]?.content).not.toContain(content);
    expect(kept.snapshot).toEqual({ spaceId: "s1", key: openSpaceKey(open), full: false });
  });

  it("sends it in full when it changed", async () => {
    modelSays.history = sentBefore();
    const changed = { ...open, content: content.replace("Hero", "Villain") };

    await runWithSpaceOpen(changed);

    const kept = setUserForModel.mock.calls[0]?.[2] as { messages: Array<{ content: string }>; snapshot: unknown };
    expect(kept.messages[0]?.content).toContain("Villain");
    expect(kept.snapshot).toEqual({ spaceId: "s1", key: openSpaceKey(changed), full: true });
  });
});

describe("two turns in a row", () => {
  it("send the second request as the first one with the reply and the new question after it", async () => {
    // A store in memory, written and read the way the repository is.
    const store: Array<MessageData & { forModel: unknown }> = [];
    let nextTurn = 1;
    addMessage.mockImplementation(async (_id, message, forModel) => {
      const turnIndex = message.role === "user" ? nextTurn++ : (message.turnIndex as number);
      store.push({ role: message.role as "user" | "assistant", content: "", parts: message.parts as never, ts: "", turnIndex, forModel: forModel ?? null });
      return turnIndex;
    });
    setUserForModel.mockImplementation(async (_id, turnIndex, forModel) => {
      const row = store.find((r) => r.role === "user" && r.turnIndex === turnIndex);
      if (row) row.forModel = forModel;
    });
    modelSays.history = store;

    await runOneTurn("first question");
    modelSays.parts = saying("second reply");
    await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
      const turn = await new MainAgent().chat("second question", undefined, [], "UTC");
      for await (const _chunk of turn) void _chunk;
    });

    const first = modelSays.prompts[0] as unknown[];
    const second = modelSays.prompts[1] as Array<{ role: string; content: unknown }>;
    expect(JSON.stringify(second.slice(0, first.length))).toBe(JSON.stringify(first));
    expect(second[first.length]?.role).toBe("assistant");
    expect(JSON.stringify(second[first.length])).toContain("the reply");
    expect(second.at(-1)?.role).toBe("user");
    expect(JSON.stringify(second.at(-1))).toContain("second question");
  });
});
