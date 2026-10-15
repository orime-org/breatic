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
import { tool } from "ai";
import type { ModelMessage, ToolSet } from "ai";
import { z } from "zod";
import type * as CoreModule from "@breatic/core";
import type { MessageData } from "@breatic/shared";
import { prefixHash, type RequestPrefix } from "@server/agent/history-replay.js";
import { endingNote } from "@server/agent/model-messages.js";
import { UNCHANGED_SPACE_NOTE, openSpaceKey } from "@server/agent/user-turn.js";
import { measureMessages } from "@server/agent/payload-size.js";
import { FINISHED_ASKING_FOR_A_TOOL, finishing, saying } from "../helpers/model-double.js";
import type { ModelStreamPart } from "../helpers/model-double.js";

const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>, _forModel?: unknown) => 7);
const setUserForModel = vi.fn(async (_id: string, _turn: number, _forModel: unknown) => undefined);
const modelSays = vi.hoisted(() => ({
  parts: [] as unknown[],
  /** What each model call produces, by call, across the case; `parts` past its end. */
  byCall: [] as unknown[][],
  prompts: [] as unknown[],
  history: [] as Array<MessageData & { forModel: unknown }>,
  tools: {},
  /** Leave the model's stream open until the turn is stopped. */
  openUntilStopped: false,
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
    buildAgentConfig: () => ({ modelId: "test", instructions: "system", tools: modelSays.tools }),
    // The real one, so the reply is written down.
    finalizeTurn: actual.finalizeTurn,
    getModel: () =>
      modelProducing(
        // Called once the call's prompt is pushed, so the call is the last one.
        () => (modelSays.byCall[modelSays.prompts.length - 1] ?? modelSays.parts) as ModelStreamPart[],
        (asked) => modelSays.prompts.push(asked.prompt),
        modelSays.openUntilStopped,
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
const PREFIX: RequestPrefix = { instructions: "system", tools: {}, modelId: "test" };

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
  modelSays.byCall = [];
  modelSays.tools = {};
  modelSays.openUntilStopped = false;
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
    modelSays.history = earlierTurn({ ...PREFIX, instructions: "an older system prompt" });

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

    expect(keptReply().messages.at(-1)).toEqual({ role: "assistant", content: endingNote([{ type: "failed" }]) });
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
        forModel: { messages: [ASKED], snapshot: { ...openSpaceKey(open), full: true } },
      },
    ];
  }

  it("says it is unchanged when it is what was last sent in full", async () => {
    modelSays.history = sentBefore();

    await runWithSpaceOpen(open);

    const kept = setUserForModel.mock.calls[0]?.[2] as { messages: Array<{ content: string }>; snapshot: unknown };
    expect(kept.messages[0]?.content).toContain(UNCHANGED_SPACE_NOTE);
    expect(kept.messages[0]?.content).not.toContain(content);
    expect(kept.snapshot).toEqual({ ...openSpaceKey(open), full: false });
  });

  it("sends it in full when it changed", async () => {
    modelSays.history = sentBefore();
    const changed = { ...open, content: content.replace("Hero", "Villain") };

    await runWithSpaceOpen(changed);

    const kept = setUserForModel.mock.calls[0]?.[2] as { messages: Array<{ content: string }>; snapshot: unknown };
    expect(kept.messages[0]?.content).toContain("Villain");
    expect(kept.snapshot).toEqual({ ...openSpaceKey(changed), full: true });
  });
});

/** Signed thinking, which goes back only while everything before it is as sent. */
const THINKING: ModelStreamPart[] = [
  { type: "reasoning-start", id: "r1" },
  { type: "reasoning-delta", id: "r1", delta: "I should look." },
  { type: "reasoning-end", id: "r1", providerMetadata: { anthropic: { signature: "sig" } } },
];

/** The model thinking, then asking for the lookup tool. */
const ASKS_FOR_LOOKUP: ModelStreamPart[] = [
  ...THINKING,
  { type: "tool-call", toolCallId: "tc-1", toolName: "lookup", input: JSON.stringify({ q: "cats" }) },
  FINISHED_ASKING_FOR_A_TOOL,
];

/**
 * A lookup tool that answers, or that stops the turn and waits out the stop.
 * @param stopper - Pressed from inside the tool, when it is to stop the turn.
 * @returns The tools the turn is built with.
 */
function lookupTool(stopper?: AbortController): ToolSet {
  return {
    lookup: tool({
      description: "Look something up.",
      inputSchema: z.object({ q: z.string() }),
      execute: async (_input: { q: string }, { abortSignal }) => {
        if (stopper === undefined) return "three results";
        stopper.abort();
        await new Promise<void>((resolve) => {
          if (abortSignal === undefined || abortSignal.aborted) resolve();
          else abortSignal.addEventListener("abort", () => resolve());
        });
        return "too late";
      },
    }),
  };
}

/** A turn's first call, set up one way to end. */
interface Ending {
  name: string;
  /** What each of the first turn's model calls produces. */
  calls: ModelStreamPart[][];
  /** The lookup tool's stop, when it stops the turn. */
  toolStops?: boolean;
  /** Stop the turn when a chunk of this type comes out of it. */
  stopOnChunk?: string;
  /** What the earlier reply sends again, after the earlier turn's last request. */
  carries: string;
}

const ENDINGS: Ending[] = [
  { name: "one step of prose", calls: [[...THINKING, ...saying("the reply")]], carries: "the reply" },
  { name: "a tool call and then prose", calls: [ASKS_FOR_LOOKUP, saying("found three")], carries: "found three" },
  {
    name: "cut off at the output limit",
    calls: [
      [
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "a long answer that" },
        { type: "text-end", id: "t1" },
        finishing("length", 1),
      ],
    ],
    carries: "a long answer that",
  },
  {
    name: "stopped inside the first step",
    calls: [
      [
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "half an ans" },
      ],
    ],
    stopOnChunk: "text-delta",
    carries: "half an ans",
  },
  { name: "stopped while the tool ran", calls: [ASKS_FOR_LOOKUP], toolStops: true, carries: '"toolCallId":"tc-1"' },
  {
    name: "a provider error after the tool call",
    calls: [[...ASKS_FOR_LOOKUP.slice(0, -1), { type: "error", error: new Error("overloaded") }]],
    carries: "could not be finished",
  },
  {
    name: "a provider error in the middle of thinking",
    calls: [
      [
        { type: "reasoning-start", id: "r1" },
        { type: "reasoning-delta", id: "r1", delta: "half a thou" },
        { type: "error", error: new Error("overloaded") },
      ],
    ],
    carries: "could not be finished",
  },
];

/**
 * The tool call ids a provider-level prompt holds, by what holds them.
 * @param prompt - The prompt.
 * @returns The calls asked for, and the calls answered.
 */
function callsIn(prompt: Array<{ role: string; content: unknown }>): { asked: string[]; answered: string[] } {
  const parts = prompt.flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string; toolCallId?: string }>) : []));
  return {
    asked: parts.filter((p) => p.type === "tool-call").map((p) => p.toolCallId ?? ""),
    answered: parts.filter((p) => p.type === "tool-result").map((p) => p.toolCallId ?? ""),
  };
}

describe("the turn after one that ended", () => {
  it.each(ENDINGS)("$name starts with the bytes of the earlier turn's last request", async (ending) => {
    // A store in memory, written and read the way the repository is.
    const store: Array<MessageData & { forModel: unknown }> = [];
    let nextTurn = 1;
    addMessage.mockImplementation(async (_id, message, forModel) => {
      const turnIndex = message.role === "user" ? nextTurn++ : (message.turnIndex as number);
      // Through JSON, as a JSONB column hands it back.
      const kept = forModel === undefined ? null : (JSON.parse(JSON.stringify(forModel)) as unknown);
      store.push({ role: message.role as "user" | "assistant", content: "", parts: message.parts as never, ts: "", turnIndex, forModel: kept });
      return turnIndex;
    });
    setUserForModel.mockImplementation(async (_id, turnIndex, forModel) => {
      const row = store.find((r) => r.role === "user" && r.turnIndex === turnIndex);
      if (row) row.forModel = JSON.parse(JSON.stringify(forModel)) as unknown;
    });
    modelSays.history = store;
    const stopper = new AbortController();
    modelSays.tools = lookupTool(ending.toolStops === true ? stopper : undefined);
    modelSays.byCall = ending.calls;
    modelSays.openUntilStopped = ending.stopOnChunk !== undefined;

    await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
      const turn = await new MainAgent().chat("first question", stopper.signal, [], "UTC");
      for await (const chunk of turn) if (chunk.type === ending.stopOnChunk) stopper.abort();
    });
    const lastOfFirst = modelSays.prompts.at(-1) as unknown[];
    modelSays.openUntilStopped = false;
    modelSays.parts = saying("second reply");
    await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
      const turn = await new MainAgent().chat("second question", undefined, [], "UTC");
      for await (const _chunk of turn) void _chunk;
    });

    const second = modelSays.prompts.at(-1) as Array<{ role: string; content: unknown }>;
    expect(modelSays.prompts).toHaveLength(ending.calls.length + 1);
    expect(JSON.stringify(second.slice(0, lastOfFirst.length))).toBe(JSON.stringify(lastOfFirst));
    expect(second[lastOfFirst.length]?.role).toBe("assistant");
    expect(JSON.stringify(second.slice(lastOfFirst.length, -1))).toContain(ending.carries);
    expect(second.at(-1)?.role).toBe("user");
    expect(JSON.stringify(second.at(-1))).toContain("second question");
    // Every call sent has its result beside it, or the provider refuses it.
    const { asked, answered } = callsIn(second);
    expect(answered.sort()).toEqual(asked.sort());
    // Thinking goes back only from a step that finished.
    if (ending.stopOnChunk !== undefined || ending.calls.some((call) => call.some((part) => part.type === "error"))) {
      expect(JSON.stringify(second.slice(lastOfFirst.length, -1))).not.toContain('"reasoning"');
    }
  });
});
