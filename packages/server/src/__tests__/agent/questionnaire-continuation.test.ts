// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The segment of a turn that resumes after the reader answers a questionnaire
 * (inner#1542).
 *
 * It belongs to the turn that asked: same turn index, the paused reply in its
 * history with the answer already appended to that reply's copy of what was
 * sent. What it adds of its own -- the reader's clock and Spaces, then the
 * reply -- is kept in its own row under the hash of everything before it, so
 * the next request sends it again as it was sent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import type * as CoreModule from "@breatic/core";
import type { MessageData } from "@breatic/shared";
import { lastFullSnapshotKey, prefixHash, replayRows, type RequestPrefix, type ReplayRow } from "@server/agent/history-replay.js";
import { costPerTurn } from "@server/agent/request-size.js";
import { saying } from "../helpers/model-double.js";
import type { ModelStreamPart } from "../helpers/model-double.js";

const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>, _forModel?: unknown) => 3);
const setUserForModel = vi.fn(async () => undefined);
const foldIfOverBudget = vi.fn(async () => false);
const usageKeys = vi.hoisted(() => ({ keys: [] as string[] }));
const modelSays = vi.hoisted(() => ({
  parts: [] as unknown[],
  prompts: [] as unknown[],
  history: [] as Array<MessageData & { forModel: unknown }>,
  runningTurn: 0,
}));

vi.mock("@server/agent/turn-context.js", () => ({
  buildTurnContext: vi.fn(async (_u: string, _c: string, _p: string, before: number) => {
    modelSays.runningTurn = before;
    return {
      memoryContext: { projectMemory: "", conversationMemory: "" },
      history: modelSays.history.filter((row) => row.turnIndex < before),
      watermark: 0,
    };
  }),
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
    buildAgentConfig: () => ({ modelId: "test", instructions: { base: "system" }, tools: {} }),
    finalizeTurn: actual.finalizeTurn,
    createUsageRecorder: (options: { operationKey: string }) => {
      usageKeys.keys.push(options.operationKey);
      return (base.createUsageRecorder as (o: unknown) => unknown)(options);
    },
    getModel: () =>
      modelProducing(
        () => modelSays.parts as ModelStreamPart[],
        (asked) => modelSays.prompts.push(asked.prompt),
      ),
  };
});

vi.mock("@server/modules/conversation/conversation-message.repo.js", () => ({
  addMessage,
  addReaderMessage: async (id: string, msg: Record<string, unknown>) => ({ turnIndex: await addMessage(id, msg), closedAsk: null }),
  setUserForModel,
  getMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
}));
vi.mock("@server/modules/conversation/conversation.service.js", () => ({
  titleForTurn: vi.fn(async () => null),
}));
vi.mock("@server/agent/turn-budget.js", () => ({ foldIfOverBudget }));

const { MainAgent } = await import("@server/agent/main-agent.js");
const { runWithContext } = await import("@breatic/core");

const PREFIX: RequestPrefix = { instructions: { base: "system" }, tools: {}, modelId: "test" };
const ASKED: ModelMessage = { role: "user", content: "make me a poster, as sent" };
const CALL: ModelMessage = {
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: "ask-1", toolName: "ask_user", input: { questions: [] } }],
};
const RESULT: ModelMessage = {
  role: "tool",
  content: [
    { type: "tool-result", toolCallId: "ask-1", toolName: "ask_user", output: { type: "json", value: { answers: [] } } },
  ],
};

/**
 * The paused turn as the repository hands it out once the answer is in.
 * @returns Its two rows.
 */
function pausedTurn(): Array<MessageData & { forModel: unknown }> {
  return [
    { role: "user", content: "make me a poster", parts: [], ts: "", turnIndex: 3, forModel: { messages: [ASKED] } },
    {
      role: "assistant",
      content: "",
      parts: [],
      ts: "",
      turnIndex: 3,
      forModel: { messages: [CALL, RESULT], prefixHash: prefixHash(PREFIX, [ASKED]), turnTokens: 4, endTokens: 9 },
    },
  ];
}

/**
 * Run the resumed segment to its end.
 * @param space - The reader's Spaces when they pressed submit.
 * @returns Every chunk of its stream.
 */
async function resume(space: Record<string, unknown> = {}): Promise<Array<Record<string, unknown>>> {
  modelSays.parts = saying("Here is your poster plan.");
  const chunks: Array<Record<string, unknown>> = [];
  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    const turn = await new MainAgent().answer("ask-1", { answers: [] }, 3, undefined, "UTC", space);
    for await (const chunk of turn) chunks.push(chunk);
  });
  return chunks;
}

/**
 * The reply row the resumed segment stored, with what it kept for the model.
 * @returns Its message and its copy.
 * @throws {Error} When none was stored.
 */
function storedReply(): { message: Record<string, unknown>; forModel: { messages: ModelMessage[]; prefixHash: string } } {
  const call = addMessage.mock.calls.find((c) => (c[1] as { role?: string }).role === "assistant");
  if (!call) throw new Error("no reply stored");
  return { message: call[1], forModel: call[2] as { messages: ModelMessage[]; prefixHash: string } };
}

beforeEach(() => {
  addMessage.mockClear();
  setUserForModel.mockClear();
  foldIfOverBudget.mockClear();
  usageKeys.keys = [];
  modelSays.prompts = [];
  modelSays.history = pausedTurn();
});

describe("the resumed segment", () => {
  it("reads the paused turn as its history, the answer included", async () => {
    await resume();
    expect(modelSays.runningTurn).toBe(4);
    const prompt = JSON.stringify(modelSays.prompts[0]);
    expect(prompt).toContain("ask-1");
    expect(prompt).toContain('"type":"tool-result"');
  });

  it("tells the browser the call is answered before anything else it says", async () => {
    const chunks = await resume();
    const first = chunks.findIndex((c) => c.type === "tool-output-available");
    expect(chunks[first]).toMatchObject({ toolCallId: "ask-1", output: { answers: [] } });
    expect(first).toBeLessThan(chunks.findIndex((c) => c.type === "text-delta"));
  });

  it("files its reply under the turn that asked, with the clock ahead of it and the hash of everything before", async () => {
    await resume();
    const { message, forModel } = storedReply();
    expect(message).toMatchObject({ role: "assistant", turnIndex: 3 });
    expect(forModel.messages[0]).toMatchObject({ role: "user" });
    expect(JSON.stringify(forModel.messages[0])).toContain("UTC");
    expect(forModel.prefixHash).toBe(prefixHash(PREFIX, [ASKED, CALL, RESULT]));
  });

  it("is sent again as it was sent by the next request", async () => {
    await resume();
    const { forModel } = storedReply();
    const rows: ReplayRow[] = [
      ...pausedTurn(),
      { role: "assistant", content: "", parts: [], ts: "", turnIndex: 3, forModel: { ...forModel, turnTokens: 2, endTokens: 11 } },
    ];
    expect(replayRows(rows, PREFIX).at(-1)?.asSent).toBe(true);
  });

  it("leaves the reader's message of that turn alone and folds nothing", async () => {
    await resume();
    expect(setUserForModel).not.toHaveBeenCalled();
    expect(foldIfOverBudget).not.toHaveBeenCalled();
  });

  it("is charged under a key of its own", async () => {
    await resume();
    expect(usageKeys.keys).toEqual(["turn:c1:3:answer:ask-1"]);
  });
});

describe("what a turn of several replies weighs", () => {
  it("is every reply of the turn added up", () => {
    const rows: ReplayRow[] = [
      ...pausedTurn(),
      {
        role: "assistant",
        content: "",
        parts: [],
        ts: "",
        turnIndex: 3,
        forModel: { messages: [], prefixHash: "x", turnTokens: 6, endTokens: 20 },
      },
    ];
    expect(costPerTurn(replayRows(rows, PREFIX))).toEqual([{ turnIndex: 3, tokens: 10 }]);
  });
});

describe("the open Space a resumed segment sent in full", () => {
  it("is what the history last sent of it", () => {
    const rows: ReplayRow[] = [
      ...pausedTurn(),
      {
        role: "assistant",
        content: "",
        parts: [],
        ts: "",
        turnIndex: 3,
        forModel: {
          messages: [],
          prefixHash: "x",
          turnTokens: 1,
          endTokens: 1,
          snapshot: { spaceId: "s1", key: "k1", full: true },
        },
      },
    ];
    expect(lastFullSnapshotKey(rows, "s1")).toBe("k1");
  });
});
