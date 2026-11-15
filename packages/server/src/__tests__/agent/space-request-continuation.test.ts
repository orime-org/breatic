// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The segment of a turn that resumes after the user answers a Space request
 * (inner#1552).
 *
 * It resumes the turn that asked, the way an answered questionnaire does. The
 * model reads the shared Spaces' content from the paused reply's kept copy,
 * where the settle appended the full result; the browser is told the call is
 * answered with the card's summary, so the content never travels back to the
 * page as the call's output.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import type * as CoreModule from "@breatic/core";
import type { MessageData } from "@breatic/shared";
import { prefixHash, type RequestPrefix } from "@server/agent/history-replay.js";
import { saying } from "../helpers/model-double.js";
import type { ModelStreamPart } from "../helpers/model-double.js";

const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>, _forModel?: unknown) => 3);
const usageKeys = vi.hoisted(() => ({ keys: [] as string[] }));
const modelSays = vi.hoisted(() => ({
  parts: [] as unknown[],
  prompts: [] as unknown[],
  history: [] as Array<MessageData & { forModel: unknown }>,
}));

vi.mock("@server/agent/turn-context.js", () => ({
  buildTurnContext: vi.fn(async (_u: string, _c: string, _p: string, before: number) => ({
    memoryContext: { entries: [], migrated: [], olderCount: 0, progress: "" },
    history: modelSays.history.filter((row) => row.turnIndex < before),
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
    ASK_USER: actual.ASK_USER,
    REQUEST_SPACE_CONTENT: actual.REQUEST_SPACE_CONTENT,
    AWAITS_USER: actual.AWAITS_USER,
    streamTextRetry: actual.streamTextRetry,
    buildAgentConfig: () => ({ modelId: "test", instructions: { base: "system" }, tools: {} }),
    finalizeTurn: actual.finalizeTurn,
    createUsageRecorder: (options: { operationKey: string }) => {
      usageKeys.keys.push(options.operationKey);
      return (base.createUsageRecorder as (o: unknown) => unknown)(options);
    },
    provider: (await import("../helpers/fake-provider.js")).fakeProvider(() =>
      modelProducing(
        () => modelSays.parts as ModelStreamPart[],
        (asked) => modelSays.prompts.push(asked.prompt),
      )),
  };
});

vi.mock("@server/modules/conversation/conversation-message.repo.js", () => ({
  addMessage,
  addUserMessage: async (id: string, msg: Record<string, unknown>) => ({ turnIndex: await addMessage(id, msg), closedAsks: [] }),
  setUserForModel: vi.fn(async () => undefined),
  getMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
}));
vi.mock("@server/modules/conversation/conversation.service.js", () => ({
  getMessagesForLlm: async () => [],
  titleForTurn: vi.fn(async () => null),
}));
vi.mock("@server/agent/turn-fold.js", () => ({ foldIfTooLong: vi.fn(async () => "none") }));

const { MainAgent } = await import("@server/agent/main-agent.js");
const { runWithContext } = await import("@breatic/core");

const PREFIX: RequestPrefix = { instructions: { base: "system" }, tools: {}, modelId: "test" };
const REQUEST = { reason: "To read the cast list.", spaces: [{ id: "c1" }] };
const WHOLE = {
  selected_total: 0,
  selected_attached: 0,
  selected_whole: 0,
  slim: false,
  texts_cut: 0,
  names_only: 0,
  edges_not_listed: 0,
  nodes_not_listed: 0,
  groups_not_listed: 0,
};

/** The result the user shared, in full. */
const FULL = {
  spaces: [{ id: "c1", name: "Cast", kind: "canvas", state: "read", content: "THE CAST LIST: Ada, Ben", total_chars: 23, detail: WHOLE }],
};

const ASKED: ModelMessage = { role: "user", content: "who is in the cast?" };
const CALL: ModelMessage = {
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: "req-1", toolName: "request_space_content", input: REQUEST }],
};
const RESULT: ModelMessage = {
  role: "tool",
  content: [{ type: "tool-result", toolCallId: "req-1", toolName: "request_space_content", output: { type: "json", value: FULL } }],
};

/**
 * The paused turn as the store hands it out once the answer is in.
 * @returns Its two rows.
 */
function pausedTurn(): Array<MessageData & { forModel: unknown }> {
  return [
    { role: "user", content: "who is in the cast?", parts: [], ts: "", turnIndex: 3, forModel: { messages: [ASKED] } },
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

/** The card's output as the store holds it after the share: a summary, no content. */
const SUMMARY = { spaces: [{ id: "c1", name: "Cast", kind: "canvas", state: "read" }] };

/**
 * Run the resumed segment to its end.
 * @param output - The call's output as the store holds it.
 * @returns Every chunk of its stream.
 */
async function resume(output: unknown): Promise<Array<Record<string, unknown>>> {
  modelSays.parts = saying("Ada and Ben.");
  const chunks: Array<Record<string, unknown>> = [];
  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    const turn = await new MainAgent().answer("req-1", output, 3, undefined, "UTC");
    for await (const chunk of turn) chunks.push(chunk);
  });
  return chunks;
}

beforeEach(() => {
  addMessage.mockClear();
  usageKeys.keys = [];
  modelSays.prompts = [];
  modelSays.history = pausedTurn();
});

describe("the segment resumed by shared Spaces", () => {
  it("sends the browser no copy of the answer and none of the shared content (ST-14)", async () => {
    const chunks = await resume(SUMMARY);
    expect(chunks.some((c) => c.type === "tool-output-available")).toBe(false);
    expect(JSON.stringify(chunks)).not.toContain("THE CAST LIST");
  });

  it("sends the model the shared content, from the paused reply's kept copy", async () => {
    await resume(SUMMARY);
    const prompt = JSON.stringify(modelSays.prompts[0]);
    expect(prompt).toContain("THE CAST LIST: Ada, Ben");
    expect(prompt).toContain('"toolName":"request_space_content"');
  });

  it("is charged under the key every answered card is", async () => {
    await resume(SUMMARY);
    expect(usageKeys.keys).toEqual(["turn:c1:3:answer:req-1"]);
  });
});

describe("the segment resumed by a refusal", () => {
  it("sends the browser no copy of the refusal (ST-14)", async () => {
    const chunks = await resume({ declined: true });
    expect(chunks.some((c) => c.type === "tool-output-available")).toBe(false);
  });
});
