// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A turn tells the model which Spaces the project has and what is in the one
 * the reader has open (inner#1413). Like the clock note, it reaches the model
 * on this turn's message only and is never stored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as CoreModule from "@breatic/core";
import { READER_LANGUAGE_REMINDER, userTurnForModel } from "@server/agent/user-turn.js";
import type { ChatCurrentSpace, ChatSpace, MessageData } from "@breatic/shared";
import { saying } from "../helpers/model-double.js";
import { readerClockNote } from "@server/agent/reader-clock.js";
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
    history: modelSays.history,
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
      return { modelId: "test", instructions: { base: "system" }, tools: {} };
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
  addReaderMessage: async (id: string, msg: Record<string, unknown>) => ({ turnIndex: await addMessage(id, msg), closedAsk: null }),
  getMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
}));
vi.mock("@server/modules/conversation/conversation.service.js", () => ({
  titleForTurn: vi.fn(async () => null),
}));
vi.mock("@server/agent/turn-budget.js", () => ({ foldIfOverBudget: vi.fn(async () => false) }));

const { MainAgent } = await import("@server/agent/main-agent.js");
const { runWithContext } = await import("@breatic/core");

const storyboard: ChatSpace = { id: "s1", name: "Storyboard", kind: "document" };
const spaces: ChatSpace[] = [storyboard, { id: "s2", name: "Cast", kind: "canvas" }];
const open: ChatCurrentSpace = { ...storyboard, state: "loaded", content: "# Scene 1", total_chars: 9 };

/**
 * Run one turn to its end.
 * @param said - What the user typed.
 * @param current - The Space the reader has open, when it is on.
 */
async function runOneTurn(said: string, current: ChatCurrentSpace | undefined): Promise<void> {
  modelSays.parts = saying("the reply");
  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    const turn = await new MainAgent().chat(said, undefined, [], "Asia/Shanghai", {
      spaces,
      spaces_total: spaces.length,
      current_space: current,
    });
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
  vi.setSystemTime(new Date("2026-10-01T09:27:00Z"));
  addMessage.mockClear();
  modelSays.prompts = [];
  modelSays.history = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a turn tells the model about the reader's Spaces", () => {
  it("sends the clock note, then the Spaces and the open one, then the words", async () => {
    await runOneTurn("summarise this", open);

    expect(userTextsSent().at(-1)).toBe(
      `${readerClockNote(new Date(), "Asia/Shanghai")}\n\n${userTurnForModel({
        chips: [],
        message: "summarise this",
        spaces,
        spaces_total: spaces.length,
        current_space: open,
      })}\n\n${READER_LANGUAGE_REMINDER}`,
    );
    expect(userTextsSent().at(-1)).toContain('## The Space the reader has open: "Storyboard" (document)');
  });

  it("stores the words without the Spaces", async () => {
    await runOneTurn("summarise this", open);

    expect(addMessage).toHaveBeenCalledWith("c1", {
      role: "user",
      parts: [{ type: "text", text: "summarise this" }],
    });
  });

  it("sends earlier user messages as they were stored, with no Spaces", async () => {
    modelSays.history = [
      { role: "user", content: "earlier question", parts: [{ type: "text", text: "earlier question" }] },
      { role: "assistant", content: "earlier answer", parts: [{ type: "text", text: "earlier answer" }] },
    ] as MessageData[];

    await runOneTurn("and now?", undefined);

    expect(userTextsSent()[0]).toBe("earlier question");
    expect(userTextsSent().at(-1)).toContain("## Spaces in this project");
  });
});
