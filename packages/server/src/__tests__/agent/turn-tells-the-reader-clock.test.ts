// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where a turn tells the model the reader's local time.
 *
 * The note opens this turn's user message and nothing else: the system prompt
 * stays word for word what it was, and the history the model is sent, which is
 * what was stored, never carries a note. So the request is the same prefix up
 * to this turn's message, which is what a provider's prefix cache matches on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as CoreModule from "@breatic/core";
import { userTurnForModel } from "@breatic/shared";
import type { ChatAttachedChip, MessageData } from "@breatic/shared";
import { saying } from "../helpers/model-double.js";
import type { ModelStreamPart } from "../helpers/model-double.js";

const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>) => 7);
const modelSays = vi.hoisted(() => ({
  parts: [] as unknown[],
  prompts: [] as unknown[],
  basePrompts: [] as unknown[],
  history: [] as MessageData[],
}));

vi.mock("@server/agent/turn-context.js", () => ({
  buildTurnContext: vi.fn(async () => ({
    memoryContext: { projectMemory: "", conversationMemory: "" },
    compressedHistory: modelSays.history,
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
    buildAgentConfig: (request: { basePrompt?: string }) => {
      modelSays.basePrompts.push(request.basePrompt);
      return { modelId: "test", instructions: "system", tools: {} };
    },
    finalizeTurn: async () => [],
    getModel: () =>
      modelProducing(
        () => modelSays.parts as ModelStreamPart[],
        (asked) => modelSays.prompts.push(asked.prompt),
      ),
  };
});

vi.mock("@server/modules/conversation/conversation-message.repo.js", () => ({
  addMessage,
  getMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
}));
vi.mock("@server/modules/conversation/conversation.service.js", () => ({
  titleForTurn: vi.fn(async () => null),
}));
vi.mock("@server/agent/turn-budget.js", () => ({ foldIfOverBudget: vi.fn(async () => false) }));

const { MainAgent } = await import("@server/agent/main-agent.js");
const { buildSystemPrompt } = await import("@server/agent/context.js");
const { runWithContext } = await import("@breatic/core");

const NOW = "2026-10-01T09:27:00Z";
const SHANGHAI_NOTE =
  "[The reader's local time when they sent this message: Thursday, 2026-10-01 17:27 (Asia/Shanghai, GMT+08:00).]";
const UNKNOWN_ZONE_NOTE =
  "[The time when the reader sent this message: Thursday, 2026-10-01 09:27 UTC. Their time zone is unknown.]";

const image: ChatAttachedChip = {
  id: "a1",
  type: "image",
  name: "cover.png",
  data_snapshot: { url: "https://cdn.example/cover.png" },
};

/**
 * Run one turn to its end.
 * @param said - What the user typed.
 * @param chips - What the user attached.
 * @param timeZone - The zone the reader's browser reported.
 */
async function runOneTurn(
  said: string,
  chips: ChatAttachedChip[],
  timeZone: string | undefined,
): Promise<void> {
  modelSays.parts = saying("the reply");
  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    const turn = await new MainAgent().chat(said, undefined, chips, timeZone);
    for await (const _chunk of turn) void _chunk;
  });
}

/**
 * The text of every user message the model was last sent, oldest first.
 * @returns Those texts.
 */
function userTextsSent(): string[] {
  const prompt = modelSays.prompts.at(-1) as Array<{ role: string; content: unknown }>;
  return prompt
    .filter((m) => m.role === "user")
    .map((m) => {
      const content = m.content as Array<{ type: string; text?: string }> | string;
      return typeof content === "string" ? content : content.map((p) => p.text ?? "").join("");
    });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  addMessage.mockClear();
  modelSays.prompts = [];
  modelSays.basePrompts = [];
  modelSays.history = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a turn tells the model the reader's local time", () => {
  it("opens the user message with the note, then a blank line, then the words", async () => {
    await runOneTurn("what time is it?", [], "Asia/Shanghai");

    expect(userTextsSent().at(-1)).toBe(`${SHANGHAI_NOTE}\n\nwhat time is it?`);
  });

  it("puts the note ahead of the attached content when something is attached", async () => {
    await runOneTurn("what is in this?", [image], "Asia/Shanghai");

    expect(userTextsSent().at(-1)).toBe(
      `${SHANGHAI_NOTE}\n\n${userTurnForModel([image], "what is in this?")}`,
    );
  });

  it("gives UTC and says the zone is unknown when none came with the message", async () => {
    await runOneTurn("what time is it?", [], undefined);

    expect(userTextsSent().at(-1)).toBe(`${UNKNOWN_ZONE_NOTE}\n\nwhat time is it?`);
  });

  it("stores the words without the note", async () => {
    await runOneTurn("what time is it?", [], "Asia/Shanghai");

    expect(addMessage).toHaveBeenCalledWith("c1", {
      role: "user",
      parts: [{ type: "text", text: "what time is it?" }],
    });
  });

  it("sends earlier user messages as they were stored, with no note", async () => {
    modelSays.history = [
      { role: "user", content: "earlier question", parts: [{ type: "text", text: "earlier question" }] },
      { role: "assistant", content: "earlier answer", parts: [{ type: "text", text: "earlier answer" }] },
    ] as MessageData[];

    await runOneTurn("and now?", [], "Asia/Shanghai");

    expect(userTextsSent()).toEqual(["earlier question", `${SHANGHAI_NOTE}\n\nand now?`]);
  });

  it("reads the clock again on every turn", async () => {
    await runOneTurn("first", [], "Asia/Shanghai");
    vi.setSystemTime(new Date("2026-10-02T01:00:00Z"));
    await runOneTurn("second", [], "Asia/Shanghai");

    expect(userTextsSent().at(-1)).toBe(
      "[The reader's local time when they sent this message: Friday, 2026-10-02 09:00 (Asia/Shanghai, GMT+08:00).]\n\nsecond",
    );
  });

  it("leaves the system prompt word for word what it is at any other time", async () => {
    await runOneTurn("what time is it?", [], "Asia/Shanghai");
    vi.setSystemTime(new Date("2027-05-20T23:59:00Z"));

    expect(modelSays.basePrompts).toEqual([buildSystemPrompt()]);
  });
});
