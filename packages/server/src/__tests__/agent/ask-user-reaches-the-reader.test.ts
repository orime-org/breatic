// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The question the model asked arrives as part of the reply.
 *
 * The tool hands back a payload, which on its own reaches nobody: the panel
 * draws the reply's text, and a payload sitting on a tool part is not text.
 * So the turn writes it, and what it writes is the reply -- copyable, stored,
 * and rebuilt on a reload the way every other line of a reply is.
 *
 * What it writes is the model's own words and nothing else, which is what
 * keeps the whole paragraph in the language the conversation is in.
 *
 * Two calls can land in one step, since nothing stops a model calling a tool
 * twice at once. The reader is put one question a turn, so only the first is
 * in the reply; the other is turned away, with nothing drawn for it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as CoreModule from "@breatic/core";
import { FINISHED, FINISHED_ASKING_FOR_A_TOOL } from "../helpers/model-double.js";
import type { ModelStreamPart } from "../helpers/model-double.js";
import { TURNED_AWAY } from "@breatic/shared";

const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>) => 1);
const foldIfOverBudget = vi.fn(async () => false);

/** What the model produces, one entry per call it is asked to make. */
const modelSays = vi.hoisted(() => ({ perCall: [] as unknown[][], calls: 0 }));

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
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    ...base,
    runWithContext: actual.runWithContext,
    getContext: actual.getContext,
    runWithLocale: actual.runWithLocale,
    logger: { ...logger, child: () => logger },
  };
});

vi.mock("@breatic/domain", async (importOriginal) => {
  const { domainMock } = await import("../helpers/mock-core.js");
  const base = await domainMock();
  const actual = await importOriginal<Record<string, unknown>>();
  const { MockLanguageModelV4 } = await import("ai/test");

  // The real tool, not a stand-in for it. A hand-written double declares its
  // own fields, and a field the real one grows arrives here as an unknown key
  // that zod strips in silence -- so the turn under test would draw a payload
  // production cannot produce, and go on passing.
  const { makeAskUserTool } = await import("../../../../domain/src/agent/tools/ask-user.js");

  return {
    ...base,
    streamTextRetry: actual.streamTextRetry,
    buildAgentConfig: () => ({
      modelId: "test",
      instructions: "system",
      // One per turn, as the registry builds it: the tool holds whether this
      // turn has asked yet.
      tools: { ask_user: makeAskUserTool() },
    }),
    // Runs the one step this file is about. The real one runs them all in
    // order; what matters here is that storage is reached at all, because the
    // question travels back to the reader as stored text and nothing else.
    finalizeTurn: async (request: { steps: { persist?: () => Promise<void> } }) => {
      await request.steps.persist?.();
      return [];
    },
    getModel: () =>
      new MockLanguageModelV4({
        doStream: async () => {
          const script = modelSays.perCall[modelSays.calls] ?? [FINISHED];
          modelSays.calls += 1;
          return {
            stream: new ReadableStream({
              start(controller) {
                for (const part of script) controller.enqueue(part as never);
                controller.close();
              },
            }),
          };
        },
      }),
  };
});

vi.mock("@server/modules/conversation/conversation-message.repo.js", () => ({
  addMessage,
  getMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
}));

vi.mock("@server/modules/conversation/conversation.service.js", () => ({
  titleForTurn: vi.fn(async () => null),
}));

vi.mock("@server/agent/turn-budget.js", () => ({ foldIfOverBudget }));
vi.mock("@server/agent/context.js", () => ({ buildSystemPrompt: () => "system" }));

const { MainAgent } = await import("@server/agent/main-agent.js");
const { runWithContext } = await import("@breatic/core");

/**
 * One model call that asks the question and ends there.
 * @param calls - The arguments of each call the model makes in this step.
 * @returns The parts of that model call.
 */
function asks(calls: Array<Record<string, unknown>>): ModelStreamPart[] {
  return [
    ...calls.map((input, index) => ({
      type: "tool-call" as const,
      toolCallId: `call-${String(index)}`,
      toolName: "ask_user",
      input: JSON.stringify(input),
    })),
    FINISHED_ASKING_FOR_A_TOOL,
  ];
}

/**
 * Run one turn and report the reply's text.
 * @param script - What the model produces on its one call.
 * @returns Everything the turn wrote as text, joined in order.
 */
async function replyText(script: ModelStreamPart[]): Promise<string> {
  return (await turnOn(script)).text;
}

/**
 * Run one turn and report what the reader was sent.
 * @param script - What the model produces on its one call.
 * @returns The reply's text, and the error field of each tool call that ended
 *   in one, by call id.
 */
async function turnOn(
  script: ModelStreamPart[],
): Promise<{ text: string; toolErrors: Record<string, string | undefined> }> {
  modelSays.perCall = [script];
  modelSays.calls = 0;
  let text = "";
  const toolErrors: Record<string, string | undefined> = {};

  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    const turn = await new MainAgent().chat("帮我看看");
    for await (const chunk of turn) {
      const part = chunk as { type: string; delta?: string; toolCallId?: string; errorText?: string };
      if (part.type === "text-delta") text += part.delta ?? "";
      if (part.type === "tool-output-error" && part.toolCallId !== undefined) {
        toolErrors[part.toolCallId] = part.errorText;
      }
    }
  });

  return { text, toolErrors };
}

describe("a question with options", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is in the reply, numbered, and ends on the last option", async () => {
    const text = await replyText(
      asks([{ question: "这段片子的节奏，你想要哪种？", options: ["快切", "中速", "慢"] }]),
    );

    // The whole string, blank lines included: what runs into what is exactly
    // what this paragraph has to survive, and a `toContain` would pass on a
    // reply where it ran into the sentence before it.
    expect(text).toBe("\n\n这段片子的节奏，你想要哪种？\n\n1. 快切\n2. 中速\n3. 慢\n\n");
  });
});

describe("a question with nothing to choose from", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is in the reply on its own, with no list under it", async () => {
    const text = await replyText(asks([{ question: "这段片子给谁看？" }]));

    expect(text).toBe("\n\n这段片子给谁看？\n\n");
  });
});

describe("what the model said about answering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("travels the whole way and lands under the list", async () => {
    // Every other assertion here would hold with this field dropped somewhere
    // between the model and the reply, and it is the one part of the paragraph
    // the model owns outright.
    const text = await replyText(
      asks([
        {
          question: "哪一种？",
          options: ["快", "慢"],
          howToAnswer: "回一个数字就行，也可以直接说你的想法。",
        },
      ]),
    );

    expect(text).toBe("\n\n哪一种？\n\n1. 快\n2. 慢\n\n回一个数字就行，也可以直接说你的想法。\n\n");
  });
});

describe("what is left in storage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("holds the question as the reply's own text", async () => {
    // The tool part is dropped on the way back to the model because the
    // question is in the body. That is only true while the body really carries
    // it: on a reload this text is the whole of what the reader gets back.
    await replyText(asks([{ question: "哪一种？", options: ["快", "慢"] }]));

    const stored = addMessage.mock.calls.at(-1)?.[1] as
      | { parts?: Array<{ type: string; text?: string }> }
      | undefined;
    const text = (stored?.parts ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("");

    expect(text).toBe("\n\n哪一种？\n\n1. 快\n2. 慢\n\n");
  });
});

describe("two questions in one step", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("put only the first in the reply, and draw nothing for the second", async () => {
    // Stopping after a question is decided per step, so both calls run; the
    // tool is what lets only the first through. The second goes out as turned
    // away, which the panel takes as "draw nothing".
    const { text, toolErrors } = await turnOn(
      asks([{ question: "先定节奏？" }, { question: "再定时长？" }]),
    );

    expect(text).toBe("\n\n先定节奏？\n\n");
    expect(toolErrors["call-0"]).toBeUndefined();
    expect(toolErrors["call-1"]).toBe(TURNED_AWAY);
  });

  it("store the second as turned away, so a reload draws nothing for it either", async () => {
    await turnOn(asks([{ question: "先定节奏？" }, { question: "再定时长？" }]));

    const stored = addMessage.mock.calls.at(-1)?.[1] as
      | { parts?: Array<{ type: string; toolCallId?: string; failure?: { kind?: string } }> }
      | undefined;
    const second = (stored?.parts ?? []).find((part) => part.toolCallId === "call-1");
    expect(second?.failure?.kind).toBe("turned_away");
  });
});
