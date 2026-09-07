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
 * Two questions can land in one step, since nothing stops a model calling a
 * tool twice at once, and both have to be there.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import type { ToolSet } from "ai";
import type * as CoreModule from "@breatic/core";
import { FINISHED, FINISHED_ASKING_FOR_A_TOOL } from "../helpers/model-double.js";
import type { ModelStreamPart } from "../helpers/model-double.js";

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
    getLocale: actual.getLocale,
    loadLocales: actual.loadLocales,
    logger: { ...logger, child: () => logger },
  };
});

vi.mock("@breatic/domain", async (importOriginal) => {
  const { domainMock } = await import("../helpers/mock-core.js");
  const base = await domainMock();
  const actual = await importOriginal<Record<string, unknown>>();
  const { MockLanguageModelV4 } = await import("ai/test");
  const { tool: makeTool } = await import("ai");
  const { z: zod } = await import("zod");

  /** The one tool under test, handing back what it was given. */
  const asking: ToolSet[string] = makeTool({
    description: "Ask the user a question",
    inputSchema: zod.object({
      question: zod.string(),
      options: zod.array(zod.string()).optional(),
    }),
    execute: async (input: { question: string; options?: string[] }) => ({
      question: input.question,
      options: input.options ?? [],
    }),
  });

  return {
    ...base,
    streamTextRetry: actual.streamTextRetry,
    buildAgentConfig: () => ({
      modelId: "test",
      instructions: "system",
      tools: { ask_user: asking },
    }),
    finalizeTurn: async () => [],
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
const { runWithContext, loadLocales } = await import("@breatic/core");

// The real catalogue, so the closing line is asserted as the reader gets it.
// A service entry point does this at boot; nothing has booted here.
beforeAll(() => {
  loadLocales();
});

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
  modelSays.perCall = [script];
  modelSays.calls = 0;
  let written = "";

  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    const turn = await new MainAgent().chat("帮我看看");
    for await (const chunk of turn) {
      const part = chunk as { type: string; delta?: string };
      if (part.type === "text-delta") written += part.delta ?? "";
    }
  });

  return written;
}

describe("a question with options", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is in the reply, numbered, with the line saying a number is enough", async () => {
    const text = await replyText(
      asks([{ question: "这段片子的节奏，你想要哪种？", options: ["快切", "中速", "慢"] }]),
    );

    expect(text).toContain("这段片子的节奏，你想要哪种？");
    expect(text).toContain("1. 快切");
    expect(text).toContain("2. 中速");
    expect(text).toContain("3. 慢");
    expect(text).toContain("A number is enough");
  });
});

describe("a question with nothing to choose from", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is in the reply on its own, with no list and no closing line", async () => {
    const text = await replyText(asks([{ question: "这段片子给谁看？" }]));

    expect(text).toContain("这段片子给谁看？");
    expect(text).not.toContain("1. ");
    expect(text).not.toContain("A number is enough");
  });
});

describe("two questions in one step", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("are both in the reply, in the order they were asked", async () => {
    // Stopping after a question is decided per step, so a model calling the
    // tool twice at once runs both. Drawing one of them would leave the
    // reader answering a question they cannot see.
    const text = await replyText(
      asks([{ question: "先定节奏？" }, { question: "再定时长？" }]),
    );

    expect(text).toContain("先定节奏？");
    expect(text).toContain("再定时长？");
    expect(text.indexOf("先定节奏？")).toBeLessThan(text.indexOf("再定时长？"));
  });
});
