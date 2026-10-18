// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A turn that asks the user something stops there and waits.
 *
 * The model asking a question is not a step on the way to an answer -- it is
 * where this segment of the turn stops, until the reader answers on the card
 * or writes a message (inner#1542). `ask_user` has no `execute`, so the SDK
 * stops the step at the call and the call is stored as `awaiting`; the panel
 * is told on the wire which call it is, because it cannot work that out.
 *
 * Only the tool that asks something stops a turn. `search_images` puts
 * something on screen and the model is meant to keep writing around it,
 * several times in one turn if it likes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as CoreModule from "@breatic/core";
import { FINISHED, FINISHED_ASKING_FOR_A_TOOL } from "../helpers/model-double.js";
import type { ModelStreamPart } from "../helpers/model-double.js";

const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>) => 1);
const foldIfOverBudget = vi.fn(async () => false);
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
    history: [],
  })),
}));

// `search_images` reaches the transport, and what this file is about is which
// tool ends a turn. One stubbed answer is enough for it to return; what that
// tool does with a real service is pinned in its own suite.
vi.mock("@breatic/shared", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    httpRequest: async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              title: "A picture",
              url: "https://page.example/1",
              source: "example",
              thumbnail: { src: "https://thumb.example/1.jpg", width: 500, height: 400 },
              properties: { url: "https://img.example/1.jpg", width: 1000, height: 800 },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  };
});

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

  // The real tools. What this file is about is which of them ends the turn,
  // and a stand-in answering with a bare string drives the drawing path with a
  // shape production cannot produce -- silently, since a reply's text is not
  // what these assertions read.
  const { makeAskUserTool } = await import("../../../../domain/src/agent/tools/ask-user.js");
  const { imageSearch } = await import("../../../../domain/src/agent/tools/image-search.js");

  return {
    ...base,
    streamTextRetry: actual.streamTextRetry,
    buildAgentConfig: () => ({
      modelId: "test",
      instructions: { base: "system" },
      tools: {
        ask_user: makeAskUserTool({ mediaUrlAllowed: () => false }),
        search_images: imageSearch,
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
  addReaderMessage: async (id: string, msg: Record<string, unknown>) => ({ turnIndex: await addMessage(id, msg), closedAsks: [] }),
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
 * A call each real tool accepts.
 *
 * A call the schema refuses proves nothing about which tool ends a turn -- it
 * proves the arguments were wrong.
 */
const VALID_INPUT: Record<string, Record<string, unknown>> = {
  ask_user: { questions: [{ header: "Style", question: "Which style?", options: [{ label: "Calm" }, { label: "Busy" }] }] },
  search_images: { query: "a subject" },
};

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
      input: JSON.stringify(VALID_INPUT[toolName]),
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
 * @returns How many times the model was asked, how the line said it ended, and
 *   which tools answered -- a call the schema refused produces no result
 *   either, so a turn that carried on proves nothing about the tool it named
 *   until that tool is in this set. Named rather than counted, because a
 *   script running two tools is satisfied by either one of them.
 *
 *   The name comes off the call id, which `asksFor` builds as `call-<tool>`:
 *   the chunk itself carries only that id and the output.
 */
async function runTurn(
  perCall: ModelStreamPart[][],
): Promise<{ modelCalls: number; exit: unknown; sent: string[]; answered: Set<string> }> {
  modelSays.perCall = perCall;
  modelSays.calls = 0;
  const sent: string[] = [];
  const answered = new Set<string>();

  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    const turn = await new MainAgent().chat("帮我看看");
    for await (const chunk of turn) {
      const part = chunk as { type: string; toolCallId?: string };
      sent.push(part.type);
      if (part.type === "tool-output-available" && part.toolCallId !== undefined) {
        answered.add(part.toolCallId.replace(/^call-/, ""));
      }
    }
  });

  const line = logInfo.mock.calls.find((call) => call[1] === "agent_response");
  return {
    modelCalls: modelSays.calls,
    exit: (line?.[0] as Record<string, unknown> | undefined)?.exit,
    sent,
    answered,
  };
}

describe("a turn that asked the user something", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stops at the card instead of talking past it", async () => {
    const { modelCalls, answered } = await runTurn([asksFor("ask_user"), carriesOn]);

    // One call, not two, and no result for the card: the reader gives it.
    expect(modelCalls).toBe(1);
    expect(answered).toEqual(new Set());
  });

  it("stops on a question asked partway in, not only on the first thing it did", async () => {
    const { modelCalls, exit, answered } = await runTurn([asksFor("search_images"), asksFor("ask_user"), carriesOn]);

    expect(answered).toEqual(new Set(["search_images"]));
    expect(modelCalls).toBe(2);
    expect(exit).toBe("blocked");
  });

  it("says on the wire which call it is waiting on, so the panel draws a card rather than a call that came to nothing", async () => {
    const { sent } = await runTurn([asksFor("ask_user"), carriesOn]);

    expect(sent).toContain("data-ask-awaiting");
    expect(sent).not.toContain("data-blocked");
  });

  it("says nothing of the sort on a turn that answered and stopped", async () => {
    const { sent } = await runTurn([carriesOn]);

    expect(sent).not.toContain("data-ask-awaiting");
  });

  it("goes on when the card was refused for its arguments, so the model can read why and fix it", async () => {
    const refused: ModelStreamPart[] = [
      { type: "tool-call", toolCallId: "call-bad", toolName: "ask_user", input: JSON.stringify({ questions: [] }) },
      FINISHED_ASKING_FOR_A_TOOL,
    ];
    const { modelCalls, exit, sent } = await runTurn([refused, carriesOn]);

    expect(modelCalls).toBe(2);
    expect(exit).toBe("completed");
    expect(sent).not.toContain("data-ask-awaiting");
  });

  it("keeps going after a tool that only shows the user something", async () => {
    const { modelCalls, exit, answered } = await runTurn([asksFor("search_images"), carriesOn]);
    expect(answered).toEqual(new Set(["search_images"]));

    expect(modelCalls).toBe(2);
    expect(exit).toBe("completed");
  });
});
