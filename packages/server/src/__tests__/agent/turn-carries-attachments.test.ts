// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a turn does with the items attached to the message that opened it.
 *
 * They are stored beside the typed words rather than folded into them, so the
 * bubble shows what the reader typed and the conversation is named after it.
 * The model is sent both, attachments first, on the very turn they came with.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as CoreModule from "@breatic/core";
import { userTurnForModel } from "@breatic/shared";
import type { ChatAttachedChip } from "@breatic/shared";
import { saying } from "../helpers/model-double.js";
import type { ModelStreamPart } from "../helpers/model-double.js";

const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>) => 7);
const titleForTurn = vi.fn(async (_id: string, _said: string) => null);
const modelSays = vi.hoisted(() => ({ parts: [] as unknown[], prompts: [] as unknown[] }));

vi.mock("@server/agent/turn-context.js", () => ({
  buildTurnContext: vi.fn(async () => ({
    memoryContext: { projectMemory: "", conversationMemory: "" },
    compressedHistory: [],
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
vi.mock("@server/modules/conversation/conversation.service.js", () => ({ titleForTurn }));
vi.mock("@server/agent/turn-budget.js", () => ({ foldIfOverBudget: vi.fn(async () => false) }));
vi.mock("@server/agent/context.js", () => ({ buildSystemPrompt: () => "system" }));

const { MainAgent } = await import("@server/agent/main-agent.js");
const { runWithContext } = await import("@breatic/core");

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
 */
async function runOneTurn(said: string, chips: ChatAttachedChip[]): Promise<void> {
  modelSays.parts = saying("the reply");
  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    const turn = await new MainAgent().chat(said, undefined, chips);
    for await (const _chunk of turn) void _chunk;
  });
}

/**
 * The text of the last user message the model was sent.
 * @returns That text, joined from its parts.
 */
function lastUserTextSent(): string {
  const prompt = modelSays.prompts.at(-1) as Array<{ role: string; content: unknown }>;
  const user = prompt.filter((m) => m.role === "user").at(-1);
  const content = user?.content as Array<{ type: string; text?: string }> | string;
  return typeof content === "string" ? content : content.map((p) => p.text ?? "").join("");
}

beforeEach(() => {
  addMessage.mockClear();
  titleForTurn.mockClear();
  modelSays.prompts = [];
});

describe("a turn opened by a message with attachments", () => {
  it("stores each attachment as its own part ahead of the typed words", async () => {
    await runOneTurn("what is in this?", [image]);

    expect(addMessage).toHaveBeenCalledWith("c1", {
      role: "user",
      parts: [
        { type: "attachment", chip: image },
        { type: "text", text: "what is in this?" },
      ],
    });
  });

  it("names the conversation after the typed words alone", async () => {
    await runOneTurn("what is in this?", [image]);

    expect(titleForTurn).toHaveBeenCalledWith("c1", "what is in this?");
  });

  it("sends the model the attachments and the words on this same turn", async () => {
    await runOneTurn("what is in this?", [image]);

    expect(lastUserTextSent()).toBe(userTurnForModel([image], "what is in this?"));
  });

  it("stores and sends only the words when nothing is attached", async () => {
    await runOneTurn("hello", []);

    expect(addMessage).toHaveBeenCalledWith("c1", {
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    });
    expect(lastUserTextSent()).toBe("hello");
  });
});
