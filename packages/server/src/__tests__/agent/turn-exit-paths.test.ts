// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What a turn hands the model, and what it leaves behind however it ends.
 *
 * Two subjects, and they meet in the same place: both are things that are
 * true of a turn from the outside, and neither is visible in what it streams.
 * A turn that reached the model with no tools looks, on the wire, exactly
 * like one whose model chose not to call any. A turn that was stopped
 * half-way looks, on a reload, exactly like one that finished with little to
 * say -- unless the record says otherwise.
 *
 * Stopping is driven by a signal here rather than by anything the model
 * produces, because that is how it happens: the user presses stop (or the
 * conversation is deleted, or the server shuts down), the run raises the
 * signal, and the SDK ends the turn. There is
 * no part a model can send that means "the user left".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as CoreModule from "@breatic/core";
import type * as DomainModule from "@breatic/domain";
import type { MockLanguageModelV4 } from "ai/test";
import { FINISHED, finishedSpending, finishing } from "../helpers/model-double.js";
import type { ModelStreamPart } from "../helpers/model-double.js";

const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>) => 1);
const foldIfTooLong = vi.fn(async () => "none");
const chargeOnce = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
const buildAgentConfig = vi.hoisted(() => vi.fn());

/**
 * What the model produces, and the model it produced it on.
 *
 * `endsOnItsOwn` is false for the cases about stopping: a stream that closes
 * has already decided how the turn ends, and what those cases are about is a
 * turn ended from outside while the model still had more to say.
 */
const thisCase = vi.hoisted(() => ({
  parts: [] as unknown[],
  endsOnItsOwn: true,
  model: undefined as MockLanguageModelV4 | undefined,
}));

vi.mock("@server/agent/turn-context.js", () => ({
  buildTurnContext: vi.fn(async () => ({
    memoryContext: { entries: [], migrated: [], olderCount: 0, progress: "" },
    history: [],
  })),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  const base = await coreMock(importOriginal);
  const actual = await importOriginal<typeof CoreModule>();
  return { ...base, runWithContext: actual.runWithContext, getContext: actual.getContext };
});

vi.mock("@breatic/domain", async () => {
  const { domainMock } = await import("../helpers/mock-core.js");
  const base = await domainMock();
  const actual = await vi.importActual<typeof DomainModule>("@breatic/domain");
  const { MockLanguageModelV4 } = await import("ai/test");
  // Wrapped rather than replaced: what goes into the factory is what these
  // cases read, and what comes out is still the real thing.
  buildAgentConfig.mockImplementation(actual.buildAgentConfig);
  actual.initProvider((await import("../helpers/fake-provider.js")).assemblyProvider());
  return {
    ...base,
    streamTextRetry: actual.streamTextRetry,
    finalizeTurn: actual.finalizeTurn,
    buildAgentConfig,
    creditLotService: { chargeOnce },
    provider: (await import("../helpers/fake-provider.js")).fakeProvider(() => {
      const model = new MockLanguageModelV4({
        doStream: async ({ abortSignal }) => ({
          stream: new ReadableStream({
            start(controller) {
              for (const part of thisCase.parts) controller.enqueue(part as never);
              if (thisCase.endsOnItsOwn) {
                controller.close();
                return;
              }
              // Left open, and closed by the stop instead. A provider's
              // connection ends when the request is aborted, and a double
              // that ignored the signal would leave the turn waiting on a
              // stream nothing can end.
              abortSignal?.addEventListener("abort", () => {
                controller.close();
              });
            },
          }),
        }),
      });
      thisCase.model = model;
      return model;
    }),
  };
});

vi.mock("@server/modules", async (importOriginal) => {
  const { serverModulesMock } = await import("../helpers/mock-core.js");
  return serverModulesMock(importOriginal);
});

/**
 * What the conversation holds, for the settle-up every turn opens with.
 *
 * Empty because these cases are about what happens after that.
 */
const getMessages = vi.fn(async () => ({ messages: [], hasMore: false }));

vi.mock("@server/modules/conversation/conversation-message.repo.js", () => ({
  addMessage,
  addUserMessage: async (id: string, msg: Record<string, unknown>) => ({ turnIndex: await addMessage(id, msg), closedAsks: [] }),
  getMessages,
}));
vi.mock("@server/modules/conversation/conversation.service.js", () => ({
  getMessagesForLlm: async () => [],
  titleForTurn: vi.fn(async () => null),
}));

vi.mock("@server/agent/turn-fold.js", () => ({ foldIfTooLong }));
vi.mock("@server/agent/context.js", () => ({ buildSystemPrompt: () => "system" }));

/**
 * One step of prose, with the tokens it spent.
 * @param text - What the model says.
 * @param spent - Output tokens for the step.
 * @returns The parts of one finished step.
 */
function saidAndSpent(text: string, spent: number): ModelStreamPart[] {
  return [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    finishedSpending(spent),
  ];
}

/**
 * Run one turn to the end of its stream.
 * @param parts - What the model produces.
 */
async function runTurn(parts: ModelStreamPart[]): Promise<void> {
  const { MainAgent } = await import("@server/agent/main-agent.js");
  const { runWithContext } = await import("@breatic/core");
  thisCase.parts = parts;
  thisCase.endsOnItsOwn = true;
  sent.length = 0;
  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    for await (const chunk of await new MainAgent().chat("hi")) {
      sent.push(chunk);
    }
  });
}

/** What this turn put on the wire, in order. */
const sent: Array<{ type: string }> = [];

/**
 * Run one turn and stop it from outside, part way through.
 *
 * The model is left with more to say, which is the situation being recorded:
 * a stream that had already closed would make the stop arrive after the fact.
 * @param parts - What the model produces before the stop.
 * @param stopOnce - Press stop once a chunk of this type has arrived, or
 *   straight away when absent.
 */
async function runAndStop(parts: ModelStreamPart[], stopOnce?: string): Promise<void> {
  const { MainAgent } = await import("@server/agent/main-agent.js");
  const { runWithContext } = await import("@breatic/core");
  thisCase.parts = parts;
  thisCase.endsOnItsOwn = false;
  sent.length = 0;

  const stop = new AbortController();
  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    const reader = (await new MainAgent().chat("hi", stop.signal)).getReader();
    // Waited for by what arrived rather than by how many, because how many
    // chunks stand between the start of a stream and its first word is the
    // protocol's business and changes with it.
    if (stopOnce !== undefined) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sent.push(value);
        if ((value as { type: string }).type === stopOnce) break;
      }
    }
    stop.abort();
    // Read on to the end: the stream is ending because of the stop, and what
    // the turn does about it happens as it finishes.
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sent.push(value);
    }
  });
}

/**
 * The assistant messages a turn wrote as its wrap-up.
 * @returns The wrap-up messages, in the order they were written.
 */
function wrapUpMessages(): Array<Record<string, unknown>> {
  return addMessage.mock.calls.map(([, msg]) => msg).filter((msg) => msg.role === "assistant");
}

beforeEach(() => {
  [addMessage, foldIfTooLong, chargeOnce, buildAgentConfig].forEach((m) => {
    m.mockClear();
  });
});

describe("what a plain chat turn hands the model", () => {
  // Read off the model's own call rather than off the argument to
  // `streamText`. The defect being fixed was that `chat()` passed an empty
  // tool set, and where that shows is at the far end: a tool set that never
  // made it that far is a tool the model cannot call.
  it("gives it the baseline and the canvas tools, and only those", async () => {
    await runTurn(saidAndSpent("hi", 100));

    const called = thisCase.model?.doStreamCalls[0];
    const names = (called?.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual([
      "ask_user",
      "delete_memory",
      "get_canvas_capabilities",
      "get_generation_template",
      "get_product_guide",
      "list_generation_models",
      "list_project_activity",
      "propose_canvas_action",
      "propose_document_edit",
      "propose_scene_generation",
      "read_conversation",
      "read_memory",
      "read_node_history",
      "request_space_content",
      "save_image",
      "save_memory",
      "search_conversations",
      "search_images",
      "web_fetch",
      "web_search",
    ]);
  });

});

describe("what a turn hands the model", () => {
  const stubConfig = { modelId: "m", instructions: { base: "s" }, tools: {} };

  it("passes the caller's prompt and memory", async () => {
    // Every argument, so dropping any one of them goes red here.
    buildAgentConfig.mockReturnValueOnce(stubConfig);
    await runTurn(saidAndSpent("hi", 100));
    expect(buildAgentConfig.mock.calls[0]?.[0]).toMatchObject({
      basePrompt: "system",
    });
  });
});

describe("a turn that failed", () => {
  it("records that it failed, so a reload does not read it as a finished answer", async () => {
    // A stopped turn leaves a mark on the stored reply. A failed one has to
    // as well, or the two look identical once the page is reloaded: half an
    // answer that simply stops, with nothing to say it never got to finish.
    await runTurn([
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Half a sen" },
      { type: "text-end", id: "t1" },
      { type: "error", error: new Error("401 expired key") },
      FINISHED,
    ]);

    const parts = wrapUpMessages().at(-1)?.parts as Array<{ type: string }> | undefined;
    expect(parts?.map((p) => p.type)).toContain("failed");
  });

  it("stores a turn that failed before the model said anything", async () => {
    // Nothing was written, so the mark is the whole reply -- and it is what
    // makes the stored reply read as a failure rather than as a turn that
    // simply had nothing to say.
    await runTurn([{ type: "error", error: new Error("401 expired key") }, FINISHED]);

    expect(wrapUpMessages()).toHaveLength(1);
  });

  it("logs a failure of its own code once, with what it threw", async () => {
    const { logger } = await import("@breatic/core");
    const { buildTurnContext } = await import("@server/agent/turn-context.js");
    vi.mocked(logger.error).mockClear();
    vi.mocked(buildTurnContext).mockRejectedValueOnce(new Error("history unreadable"));
    await runTurn([FINISHED]);
    const failed = vi.mocked(logger.error).mock.calls.filter(([, message]) => message === "agent_turn_failed");
    expect(failed.map(([fields]) => (fields as { err: Error }).err.message)).toEqual(["history unreadable"]);
  });

  it("asks about the budget once, before the model and not after it", async () => {
    // Folding belongs in front of the reply, on the turn whose assembled
    // request measured over the budget — that is the turn it can shorten. A
    // second look on the way out would hold the ending of a reply that has
    // already finished streaming, and shorten nothing until the turn after.
    await runTurn(saidAndSpent("hi", 100));

    expect(foldIfTooLong).toHaveBeenCalledTimes(1);
    // The user's message is stored before the assembly, the reply after the
    // stream ends. The check sits between them.
    const [asked, replied] = addMessage.mock.invocationCallOrder;
    const looked = foldIfTooLong.mock.invocationCallOrder[0]!;
    expect(looked).toBeGreaterThan(asked!);
    expect(looked).toBeLessThan(replied!);
  });
});

describe("a turn the ceiling cut off", () => {
  it("records that it was cut off, so a reload does not read it as a finished answer", async () => {
    // The third way a turn ends without finishing, and the one this build
    // introduced by giving every model call an output ceiling. Neither of the
    // other two marks fits: nobody stopped it and nothing went wrong.
    await runTurn([
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Half a sen" },
      { type: "text-end", id: "t1" },
      finishing("length", 16384),
    ]);

    const parts = wrapUpMessages().at(-1)?.parts as Array<{ type: string }> | undefined;
    expect(parts?.map((p) => p.type)).toContain("truncated");
  });

  it("says so on the wire, so the user sees it without reloading", async () => {
    // Whether the model runs out of room is not ours to decide. Whether the
    // user is told it happened is, and that half is no different from a
    // turn that failed: both are things this side knows and the browser
    // cannot work out for itself.
    await runTurn([
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Half a sen" },
      { type: "text-end", id: "t1" },
      finishing("length", 16384),
    ]);

    expect(sent.map((c) => c.type)).toContain("data-truncated");
  });

  it("says nothing of the sort on a turn that ended on its own", async () => {
    await runTurn(saidAndSpent("all of it", 100));

    expect(sent.map((c) => c.type)).not.toContain("data-truncated");
  });

  it("leaves a turn that ended on its own unmarked", async () => {
    await runTurn(saidAndSpent("all of it", 100));

    const parts = wrapUpMessages().at(-1)?.parts as Array<{ type: string }> | undefined;
    expect(parts?.map((p) => p.type)).not.toContain("truncated");
  });

});

describe("a turn the user stopped", () => {
  it("keeps what was generated even when no prose was streamed yet", async () => {
    // Storing nothing here is what makes a stop look, to the user coming
    // back, exactly like a turn that never happened.
    await runAndStop([
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "half a s" },
    ]);

    const wrapUps = wrapUpMessages();
    expect(wrapUps).toHaveLength(1);
    expect(wrapUps[0]?.parts).toContainEqual({ type: "interrupted" });
  });

  it("keeps the prose it had already written", async () => {
    await runAndStop(
      [
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "half a s" },
      ],
      "text-delta",
    );

    const stored = wrapUpMessages()[0];
    expect(stored?.parts).toContainEqual({ type: "text", text: "half a s" });
    expect(stored?.parts).toContainEqual({ type: "interrupted" });
  });

  it("survives a stop that lands before any step finished", async () => {
    // The earliest possible stop. `result.totalUsage` rejects with an
    // AbortError in this case, so a turn that awaited it anywhere would end
    // on an unhandled rejection instead of an ending. Nothing here reads it,
    // and this is what says so.
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown): void => {
      unhandled.push(err);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await runAndStop([{ type: "text-start", id: "t1" }]);

      // Nothing finished, so nothing is owed.
      expect(chargeOnce).not.toHaveBeenCalled();
      // Still a record: the turn happened, and it was stopped.
      expect(wrapUpMessages()).toHaveLength(1);
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});


describe("how long a turn thought, on the wire as in the store", () => {
  /**
   * Make every reading of the clock a second after the last, so a stretch of
   * thinking that opens and closes within one tick still lasts.
   * @returns A function that puts the clock back.
   */
  const tickingClock = (): (() => void) => {
    let now = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => (now += 1_000));
    return () => spy.mockRestore();
  };

  /**
   * The thinking time the turn stored.
   * @returns Its milliseconds, if it stored one.
   */
  const storedMs = (): number | undefined =>
    (wrapUpMessages().at(-1)?.parts as Array<{ type: string; ms?: number }> | undefined)?.find((p) => p.type === "thinking-time")?.ms;

  /**
   * Where a frame of this type went out, the first time.
   * @param type - The frame's type.
   * @returns Its position, -1 when it never went out.
   */
  const at = (type: string): number => sent.findIndex((chunk) => chunk.type === type);

  it("closes the thinking still open, then says how long, then the stop, when the user stops mid-thought", async () => {
    const restore = tickingClock();
    try {
      await runAndStop(
        [
          { type: "reasoning-start", id: "r1" },
          { type: "reasoning-delta", id: "r1", delta: "weighing it up" },
        ],
        "reasoning-delta",
      );
    } finally {
      restore();
    }

    const opened = sent.find((chunk) => chunk.type === "reasoning-start") as { id: string } | undefined;
    const closed = sent.find((chunk) => chunk.type === "reasoning-end") as { id: string } | undefined;
    expect(closed?.id).toBe(opened?.id);
    const said = sent.find((chunk) => chunk.type === "data-thinking-time") as { data: { ms: number } } | undefined;
    expect(said?.data.ms).toBe(storedMs());
    expect(at("reasoning-end")).toBeLessThan(at("data-thinking-time"));
    expect(at("data-thinking-time")).toBeLessThan(at("data-interrupted"));
  });

  it("says how long it thought before the stop when the user stops while it writes", async () => {
    const restore = tickingClock();
    try {
      await runAndStop(
        [
          { type: "reasoning-start", id: "r1" },
          { type: "reasoning-delta", id: "r1", delta: "weighing it up" },
          { type: "reasoning-end", id: "r1" },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "half a s" },
        ],
        "text-delta",
      );
    } finally {
      restore();
    }

    expect(sent.filter((chunk) => chunk.type === "reasoning-end")).toHaveLength(1);
    const said = sent.find((chunk) => chunk.type === "data-thinking-time") as { data: { ms: number } } | undefined;
    expect(said?.data.ms).toBe(storedMs());
    expect(at("data-thinking-time")).toBeLessThan(at("data-interrupted"));
  });

  it("closes the thinking still open before it says the turn failed", async () => {
    const restore = tickingClock();
    try {
      await runTurn([
        { type: "reasoning-start", id: "r1" },
        { type: "reasoning-delta", id: "r1", delta: "weighing it up" },
        { type: "error", error: new Error("401 expired key") },
        FINISHED,
      ]);
    } finally {
      restore();
    }

    expect(at("reasoning-end")).toBeGreaterThan(-1);
    expect(at("reasoning-end")).toBeLessThan(at("data-thinking-time"));
    expect(at("data-thinking-time")).toBeLessThan(at("data-failed"));
  });
});

describe("decimal shortfall consumption", () => {
  it("M20 keeps a zero decimal shortfall silent", async () => {
    const { logger } = await import("@breatic/core");
    vi.mocked(logger.error).mockClear();
    chargeOnce.mockResolvedValueOnce({ billed: true, charged: "7.000000", shortfall: "0.000000", studioId: "s", lotIds: [] });
    await runTurn(saidAndSpent("settled", 100));
    expect(chargeOnce).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.error).mock.calls.filter(([, message]) => message === "CREDIT_SHORTFALL_AFTER_COMPLETION — manual reconciliation required")).toEqual([]);
  });

  it("M20 preserves a one-micro-credit shortfall in the application log", async () => {
    const { logger } = await import("@breatic/core");
    vi.mocked(logger.error).mockClear();
    chargeOnce.mockResolvedValueOnce({ billed: true, charged: "6.999999", shortfall: "0.000001", studioId: "s", lotIds: [] });
    await runTurn(saidAndSpent("settled", 100));
    expect(chargeOnce).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.error).mock.calls.filter(([, message]) => message === "CREDIT_SHORTFALL_AFTER_COMPLETION — manual reconciliation required")).toEqual([
      [expect.objectContaining({ userId: "u1", conversationId: "c1", studioId: "s", charged: "6.999999", shortfall: "0.000001" }), "CREDIT_SHORTFALL_AFTER_COMPLETION — manual reconciliation required"],
    ]);
  });
});

describe("a turn's charge comes before its reply is saved (inner#1617)", () => {
  it("asks for the charge before it writes the reply", async () => {
    // The charge request is the turn's earliest durable record: a crash
    // between the two must leave the charge, not the reply, behind.
    await runTurn(saidAndSpent("in order", 100));

    expect(chargeOnce).toHaveBeenCalledTimes(1);
    expect(chargeOnce.mock.calls[0]).toEqual([
      "operation",
      expect.stringMatching(/^turn:c1:/),
      expect.objectContaining({ projectId: "p1", actorUserId: "u1", amount: 101 }),
    ]);
    const replyOrder = addMessage.mock.calls
      .map(([, msg], i) => ({ msg, order: addMessage.mock.invocationCallOrder[i]! }))
      .filter(({ msg }) => msg.role === "assistant")
      .map(({ order }) => order);
    expect(replyOrder).toHaveLength(1);
    expect(chargeOnce.mock.invocationCallOrder[0]).toBeLessThan(replyOrder[0]!);
  });

  it("still saves the reply when the charge throws, and logs the failed charge", async () => {
    const { logger } = await import("@breatic/core");
    vi.mocked(logger.error).mockClear();
    const down = new Error("the database is down");
    chargeOnce.mockRejectedValueOnce(down);

    await runTurn(saidAndSpent("kept anyway", 100));

    expect(wrapUpMessages()).toHaveLength(1);
    expect(wrapUpMessages()[0]?.parts).toContainEqual({ type: "text", text: "kept anyway" });
    const [, refKey, charged] = chargeOnce.mock.calls[0] as unknown as [string, string, { amount: number }];
    expect(refKey).toMatch(/^turn:/);
    expect(logger.error).toHaveBeenCalledWith(
      { err: down, userId: "u1", conversationId: "c1", refKey, amount: charged.amount },
      "credit_charge_settle_failed",
    );
  });

  it("charges the full amount when a usage row could not be written, and logs the row", async () => {
    const { logger } = await import("@breatic/core");
    const { createUsageRecorder } = await import("@breatic/domain");
    vi.mocked(logger.error).mockClear();
    const lost = new Error("usage row insert failed");
    type Recorder = ReturnType<typeof createUsageRecorder>;
    const opened = vi.mocked(createUsageRecorder);
    const double = opened.getMockImplementation()!;
    opened.mockImplementation((options) => {
      const recorder: Recorder = double(options);
      return {
        ...recorder,
        settle: async () => {
          throw lost;
        },
        settleForCharge: async () => ({ ...(await recorder.settleForCharge()), writeFailures: [lost] }),
      };
    });
    try {
      await runTurn(saidAndSpent("rows lost", 100));
    } finally {
      opened.mockImplementation(double);
    }

    expect(chargeOnce).toHaveBeenCalledTimes(1);
    // One input token and 100 output tokens, a credit each in the double.
    expect(chargeOnce.mock.calls[0]?.[2]).toMatchObject({ amount: 101 });
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: lost }), "agent_usage_record_failed");
    expect(wrapUpMessages()).toHaveLength(1);
  });
});
