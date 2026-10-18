// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A chat turn holds what its next model call may cost before making it
 * (inner#1611).
 *
 * The first call is held before the model is asked anything, and each later
 * call before the loop goes on. A studio that cannot cover the next call ends
 * the turn there, and the turn says so on the wire. A paying tool grows the
 * same hold by its own estimate before it spends.
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
        ask_user: makeAskUserTool(),
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
 * A call each real tool accepts, so that every one of them answers.
 *
 * The turn stops on a `tool-result`, so a call the schema refuses proves
 * nothing about which tool ends a turn -- it proves the arguments were wrong.
 */
const VALID_INPUT: Record<string, Record<string, unknown>> = {
  ask_user: { question: "要什么风格?", options: ["冷淡", "热闹"] },
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


const { mocks } = await import("../helpers/mock-core.js");

describe("a turn that holds its calls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.creditHoldService.resizeHold.mockResolvedValue(true);
    mocks.creditHoldService.extendHold.mockResolvedValue(true);
  });

  it("asks the model nothing when its first call cannot be held, and says why on the wire", async () => {
    mocks.creditHoldService.resizeHold.mockResolvedValue(false);
    const { modelCalls, sent } = await runTurn([carriesOn]);

    expect(modelCalls).toBe(0);
    expect(sent).toContain("data-credits-exhausted");
  });

  it("holds the first call under the turn's key, at the most it can cost", async () => {
    await runTurn([carriesOn]);

    const first = mocks.creditHoldService.resizeHold.mock.calls[0]?.[0] as
      | { referenceId: string; amount: number; projectId: string; actorUserId: string }
      | undefined;
    expect(first?.referenceId).toMatch(/^turn:c1:/);
    expect(first).toMatchObject({ projectId: "p1", actorUserId: "u1" });
    // At least the output ceiling of 16384 tokens at the double's price of 2 a
    // million, times the multiplier of 2.5: the input only adds to it.
    expect(first?.amount).toBeGreaterThan((16_384 * 2 * 100 * 2.5) / 1_000_000);
  });

  it("stops before a later call the studio cannot cover, and says why on the wire", async () => {
    mocks.creditHoldService.resizeHold.mockResolvedValueOnce(true).mockResolvedValue(false);
    const { modelCalls, sent, answered } = await runTurn([asksFor("search_images"), carriesOn]);

    expect(answered).toEqual(new Set(["search_images"]));
    expect(modelCalls).toBe(1);
    expect(sent).toContain("data-credits-exhausted");
  });

  it("holds each later call for more than the one before, since the request only grows", async () => {
    await runTurn([asksFor("search_images"), carriesOn]);

    const amounts = mocks.creditHoldService.resizeHold.mock.calls.map((call) => (call[0] as { amount: number }).amount);
    expect(amounts).toHaveLength(2);
    expect(amounts[1]).toBeGreaterThan(amounts[0]!);
  });

  it("lets a paying tool grow the hold before it spends", async () => {
    await runTurn([asksFor("search_images"), carriesOn]);

    expect(mocks.creditHoldService.extendHold).toHaveBeenCalledWith(
      expect.objectContaining({ referenceId: expect.stringMatching(/^turn:c1:/), delta: expect.any(Number) }),
    );
  });

  it("holds nothing more for a step that stops because it asked the reader", async () => {
    await runTurn([asksFor("ask_user"), carriesOn]);

    expect(mocks.creditHoldService.resizeHold).toHaveBeenCalledTimes(1);
  });

  it("says nothing of the sort on a turn its credits covered", async () => {
    const { sent } = await runTurn([asksFor("search_images"), carriesOn]);

    expect(sent).not.toContain("data-credits-exhausted");
  });
});
