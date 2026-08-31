// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A turn that asks the user something stops there and waits.
 *
 * The model asking a question is not a step on the way to an answer -- it is
 * the end of what this turn can do. Whatever the user says back opens the next
 * turn. A turn that carried on would be talking past a question it just asked,
 * and would spend the reader's credits doing it.
 *
 * Nothing about the model's own stream says which of these happened: the
 * question and a step that merely ran out of room end the same way, so the
 * reason is ours to keep. What stops it is the condition on `stopWhen`, and
 * what tells the two apart at the end is that same condition writing down
 * that it fired.
 *
 * Only the two tools that ask something stop a turn. `propose_canvas_action`
 * and `show_search_results` put something on screen and the model is meant to
 * keep writing around them, several times in one turn if it likes; stopping
 * on those would make the first card a turn draws the last thing it says.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolSet } from "ai";
import type * as CoreModule from "@breatic/core";
import { FINISHED, FINISHED_ASKING_FOR_A_TOOL } from "../helpers/model-double.js";
import type { ModelStreamPart } from "../helpers/model-double.js";

const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>) => 1);
const consolidateIfNeeded = vi.fn(async () => undefined);
const logInfo = vi.fn();

/**
 * What the model produces, one entry per call it is asked to make.
 *
 * A list rather than one script, because what is being counted is how many
 * times the model is asked at all: a turn that stopped made one call, a turn
 * that carried on made two.
 */
const modelSays = vi.hoisted(() => ({
  perCall: [] as unknown[][],
  calls: 0,
}));

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
  const logger = { info: logInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    ...base,
    runWithContext: actual.runWithContext,
    getContext: actual.getContext,
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

  /**
   * One of the tools this file registers, all of which answer at once.
   * @param description - What it is for.
   * @returns A tool the turn can call.
   */
  const answering = (description: string): ToolSet[string] =>
    makeTool({
      description,
      inputSchema: zod.object({ text: zod.string() }),
      execute: async () => "答复",
    });

  return {
    ...base,
    streamTextRetry: actual.streamTextRetry,
    buildAgentConfig: () => ({
      modelId: "test",
      instructions: "system",
      tools: {
        ask_user_question: answering("问用户一个问题"),
        ask_user_choice: answering("让用户在几个选项里挑一个"),
        show_search_results: answering("把搜索结果摆出来"),
        propose_canvas_action: answering("提一个画布操作"),
      },
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

vi.mock("@server/agent/memory-consolidator.js", () => ({ consolidateIfNeeded }));
vi.mock("@server/agent/context.js", () => ({ buildSystemPrompt: () => "system" }));

const { MainAgent } = await import("@server/agent/main-agent.js");
const { runWithContext } = await import("@breatic/core");

/**
 * The model asking for one tool by name.
 * @param toolName - Which tool.
 * @returns The parts of one model call that ends in that request.
 */
function asksFor(toolName: string): ModelStreamPart[] {
  return [
    {
      type: "tool-call",
      toolCallId: `call-${toolName}`,
      toolName,
      input: JSON.stringify({ text: "…" }),
    },
    FINISHED_ASKING_FOR_A_TOOL,
  ];
}

/** What a model would say if it were given a second turn at the wheel. */
const carriesOn: ModelStreamPart[] = [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: "还有一件事" },
  { type: "text-end", id: "t1" },
  FINISHED,
];

/**
 * Run one turn on a given script and report what it did.
 * @param perCall - What the model produces, one entry per call.
 * @returns How many times the model was asked, and how the line said it ended.
 */
async function runTurn(
  perCall: ModelStreamPart[][],
): Promise<{ modelCalls: number; exit: unknown }> {
  modelSays.perCall = perCall;
  modelSays.calls = 0;

  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    const turn = await new MainAgent().chat("帮我看看");
    for await (const _chunk of turn) {
      // drained
    }
  });

  const line = logInfo.mock.calls.find((call) => call[1] === "agent_response");
  return {
    modelCalls: modelSays.calls,
    exit: (line?.[0] as Record<string, unknown> | undefined)?.exit,
  };
}

describe("a turn that asked the user something", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stops after the question instead of talking past it", async () => {
    const { modelCalls } = await runTurn([asksFor("ask_user_question"), carriesOn]);

    // One call, not two. The second entry in the script is what the model
    // would have said next, and the point is that it never gets asked.
    expect(modelCalls).toBe(1);
  });

  it("stops on a choice as well as on an open question", async () => {
    const { modelCalls } = await runTurn([asksFor("ask_user_choice"), carriesOn]);
    expect(modelCalls).toBe(1);
  });

  it("stops on a question asked partway in, not only on the first thing it did", async () => {
    // 问题很少出现在第一步:模型往往先查点什么,拿到结果才知道该问什么。判断
    // 「问过没有」要是读错了步 —— 比如一直读第一步 —— 这一轮就不会停,而这个
    // 分歧在只有一步的用例上完全看不出来:那时第一步就是最后一步,读哪个都对。
    const { modelCalls, exit } = await runTurn([
      asksFor("show_search_results"),
      asksFor("ask_user_question"),
      carriesOn,
    ]);

    // 两次:第一次画了张卡片继续写,第二次问了问题就停在那儿。第三段是模型
    // 拿到第三次机会才会说的话,而它不该拿到。
    expect(modelCalls).toBe(2);
    expect(exit).toBe("blocked");
  });

  it("says in the log that this is why it stopped", async () => {
    const { exit } = await runTurn([asksFor("ask_user_question"), carriesOn]);

    // Not "completed": a turn waiting on an answer and a turn that finished
    // what it had to say read the same in every other respect, and the
    // difference is what an on-call reader is looking at this line for. The
    // word is the one the old loop used, so a search for it still finds
    // both.
    expect(exit).toBe("blocked");
  });

  it("keeps going after proposing a canvas action, which is also just shown", async () => {
    // 这一条跟下面那条是两个不同的工具，各钉一次：`TOOLS_THAT_BLOCK` 是一份
    // 名单，只钉住「名单里的会停」证明不了「名单外的不停」——把这个工具误加
    // 进名单，画布建议一出现这一轮就结束，用户得再说一句才拿得到后面的话。
    const { modelCalls } = await runTurn([asksFor("propose_canvas_action"), carriesOn]);
    expect(modelCalls).toBe(2);
  });

  it("keeps going after a tool that only shows the user something", async () => {
    const { modelCalls, exit } = await runTurn([asksFor("show_search_results"), carriesOn]);

    // Two calls: the model drew a card and then carried on writing around it,
    // which is what those tools are for.
    expect(modelCalls).toBe(2);
    expect(exit).toBe("completed");
  });
});
