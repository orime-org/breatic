// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * When a turn folds memory, and what the model is sent afterwards
 * (#148, C3 N1 T1 T2).
 *
 * Consolidation used to run after the reply, on the theory that nobody is
 * waiting for it. That left the turn it was meant to shorten already sent:
 * whatever went over the budget went to the model in full, and the folding
 * only helped the turn after. It now runs in front of the reply, on the turn
 * that measured over the line, and the request is assembled a second time so
 * what goes out is the shortened one with the new memory in it.
 *
 * The budget here is small so the fixtures can be read. What it is measured
 * against is the whole assembled request — see payload-size.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as CoreModule from "@breatic/core";
import type * as DomainModule from "@breatic/domain";
import type { MessageData } from "@breatic/shared";
import { finishedSpending } from "../helpers/model-double.js";
import type { ModelStreamPart } from "../helpers/model-double.js";

// Above the fixed cost of an assembly — six tool definitions come to about
// 6,200 characters on their own — so the fixtures decide whether a turn is
// over the line, rather than the tool set doing it for them. Mutable because
// one case needs the budget to land exactly on what an assembly measures,
// and that figure moves whenever a tool is added.
const limits = vi.hoisted(() => ({ budget: 20_000, keep: 13_000 }));

const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>) => 9);
const consolidateWindow =
  vi.fn<(...args: unknown[]) => Promise<"written" | "discarded" | "superseded" | "aborted">>();
const chargeOnceForGeneration = vi.fn(async (..._args: unknown[]) => null);
const buildAgentConfig = vi.hoisted(() => vi.fn());

const thisCase = vi.hoisted(() => ({
  parts: [] as unknown[],
  endsOnItsOwn: true,
}));

/** What `buildTurnContext` answers with, one call at a time. */
const contexts = vi.hoisted(() => ({
  queue: [] as unknown[],
  lastHistory: [] as never[],
}));
const buildTurnContext = vi.fn(async () => {
  const next = contexts.queue.shift() as { compressedHistory: never[] };
  contexts.lastHistory = next.compressedHistory;
  return next;
});

vi.mock("@server/agent/turn-context.js", () => ({ buildTurnContext }));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  const base = await coreMock(importOriginal);
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...base,
    runWithContext: actual.runWithContext,
    getContext: actual.getContext,
    getAgentConfig: () => ({
      ...(base.getAgentConfig as () => Record<string, unknown>)(),
      memory_budget_chars: limits.budget,
      memory_keep_chars: limits.keep,
    }),
  };
});

vi.mock("@breatic/domain", async () => {
  const { domainMock } = await import("../helpers/mock-core.js");
  const base = await domainMock();
  const actual = await vi.importActual<typeof DomainModule>("@breatic/domain");
  const { MockLanguageModelV4 } = await import("ai/test");
  buildAgentConfig.mockImplementation(actual.buildAgentConfig);
  return {
    ...base,
    streamTextRetry: actual.streamTextRetry,
    finalizeTurn: actual.finalizeTurn,
    buildAgentConfig,
    creditLotService: { chargeOnceForGeneration },
    resolveProvider: () => "test",
    getModel: () =>
      new MockLanguageModelV4({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              for (const part of thisCase.parts) controller.enqueue(part as never);
              controller.close();
            },
          }),
        }),
      }),
  };
});

vi.mock("@server/modules", async (importOriginal) => {
  const { serverModulesMock } = await import("../helpers/mock-core.js");
  return serverModulesMock(importOriginal);
});

vi.mock("@server/modules/conversation/conversation-message.repo.js", () => ({
  addMessage,
  getMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
}));
vi.mock("@server/modules/conversation/conversation.service.js", () => ({
  titleForTurn: vi.fn(async () => null),
}));
vi.mock("@server/agent/memory-consolidator.js", () => ({ consolidateWindow }));
vi.mock("@server/agent/context.js", () => ({ buildSystemPrompt: () => "system" }));

/**
 * One turn of the stored history, sized to order.
 * @param turnIndex - The turn it belongs to.
 * @param size - How many characters the reply carries.
 * @returns The user message and the reply.
 */
function turn(turnIndex: number, size: number): MessageData[] {
  return [
    { role: "user", content: `q${turnIndex}`, parts: [{ type: "text", text: `q${turnIndex}` }], ts: "", turnIndex },
    {
      role: "assistant",
      content: "a".repeat(size),
      parts: [{ type: "text", text: "a".repeat(size) }],
      ts: "",
      turnIndex,
    },
  ];
}

/**
 * What one call to `buildTurnContext` should answer with.
 * @param history - The unconsolidated history it found.
 * @param conversationMemory - The conversation memory it read.
 * @returns The context, in the shape the turn destructures.
 */
function context(history: MessageData[], conversationMemory = "") {
  return {
    memoryContext: { projectMemory: "", conversationMemory },
    compressedHistory: history,
  };
}

/** Every chunk the last turn put on the wire. */
let sent: { type: string }[] = [];

/**
 * Run one turn to the end of its stream.
 * @param signal - Raised before the turn starts, for the stopped case.
 */
async function runTurn(signal?: AbortSignal): Promise<void> {
  const { MainAgent } = await import("@server/agent/main-agent.js");
  const { runWithContext } = await import("@breatic/core");
  thisCase.parts = [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "ok" },
    { type: "text-end", id: "t1" },
    finishedSpending(10),
  ] satisfies ModelStreamPart[];
  sent = [];
  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    for await (const chunk of await new MainAgent().chat("hi", signal)) {
      sent.push(chunk as { type: string });
    }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  contexts.queue = [];
  limits.budget = 20_000;
  limits.keep = 13_000;
  consolidateWindow.mockResolvedValue("written");
});

/**
 * What the last assembly measured, by the same ruler the budget is read with.
 * @returns The assembled length in characters.
 */
async function lastAssembledLength(): Promise<number> {
  const { measurePayload } = await import("@server/agent/payload-size.js");
  const call = buildAgentConfig.mock.calls.at(-1)?.[0] as Parameters<
    typeof DomainModule.buildAgentConfig
  >[0];
  const { buildAgentConfig: real } =
    await vi.importActual<typeof DomainModule>("@breatic/domain");
  const resolved = real(call);
  const sent = (
    await import("@server/agent/model-messages.js")
  ).toModelMessages(contexts.lastHistory);
  return measurePayload({
    instructions: resolved.instructions,
    tools: resolved.tools,
    messages: [...sent, { role: "user", content: "hi" }],
  });
}

describe("an ordinary turn", () => {
  it("compresses but does not fold, and pays for nothing extra", async () => {
    // C3: an everyday conversation is nowhere near the budget. The pass that
    // shortens tool results still runs — that is `buildTurnContext`'s job on
    // every turn — but no consolidating model call happens and no second
    // charge appears.
    contexts.queue = [context([...turn(1, 2000), ...turn(2, 2000)])];

    await runTurn();

    expect(buildTurnContext).toHaveBeenCalledTimes(1);
    expect(consolidateWindow).not.toHaveBeenCalled();
    expect(chargeOnceForGeneration).toHaveBeenCalledTimes(1);
    expect(chargeOnceForGeneration.mock.calls[0]?.[0]).toBe("turn:c1:9");
  });
});

describe("a turn that landed exactly on the budget", () => {
  it("is under the line, because the rule is over it", async () => {
    // The budget is set to what this very assembly measures, so the case
    // cannot drift when a tool is added: an implementation reading the line
    // as "at or over" folds here, and one reading it as "over" does not.
    contexts.queue = [context([...turn(1, 2000), ...turn(2, 2000)])];
    await runTurn();
    const exactly = await lastAssembledLength();

    vi.clearAllMocks();
    limits.budget = exactly;
    // The keep line goes below the assembly for both halves of this case.
    // Left above it, a pass would find itself already under the line and take
    // nothing — which looks exactly like not folding, and would let an
    // implementation reading the budget as "at or over" pass here.
    limits.keep = exactly - 3000;
    contexts.queue = [
      context([...turn(1, 2000), ...turn(2, 2000)]),
      context([...turn(2, 2000)]),
    ];

    await runTurn();

    expect(consolidateWindow).not.toHaveBeenCalled();
    expect(buildTurnContext).toHaveBeenCalledTimes(1);

    // One character lower and the same assembly is over. Asserted alongside
    // the line itself: without it, a figure that came out too high would
    // leave the case above passing for the wrong reason.
    vi.clearAllMocks();
    limits.budget = exactly - 1;
    limits.keep = exactly - 3000;
    contexts.queue = [
      context([...turn(1, 2000), ...turn(2, 2000)]),
      context([...turn(2, 2000)]),
    ];

    await runTurn();

    expect(consolidateWindow).toHaveBeenCalledTimes(1);
  });
});

describe("a turn that measured over the budget", () => {
  it("takes whole turns from the oldest end, and stops when enough is gone", async () => {
    // Three turns of 6,000 on a 6,200 fixed cost is about 24,200 assembled.
    // Taking the first leaves 18,200 and the second leaves 12,200, which is
    // under the keep line — so the third stays and the boundary is turn 2.
    contexts.queue = [
      context([...turn(1, 6000), ...turn(2, 6000), ...turn(3, 6000)]),
      context([...turn(3, 6000)], "what turns 1 and 2 came to"),
    ];

    await runTurn();

    expect(consolidateWindow).toHaveBeenCalledTimes(1);
    const asked = consolidateWindow.mock.calls[0]?.[0] as {
      newWatermark: number;
      watermarkBefore: number;
      transcript: { content: unknown }[];
      conversationId: string;
    };
    expect(asked.conversationId).toBe("c1");
    expect(asked.newWatermark).toBe(2);

    const folded = JSON.stringify(asked.transcript);
    expect(folded).toContain("q1");
    expect(folded).toContain("q2");
    expect(folded).not.toContain("q3");
  });

  it("tells the reader why this turn is taking longer", async () => {
    // N3: the fold is a second model call in front of the reply, seconds
    // long, on a turn where somebody is watching an empty panel. It does not
    // make the wait shorter; it makes it explainable.
    contexts.queue = [
      context([...turn(1, 6000), ...turn(2, 6000), ...turn(3, 6000)]),
      context([...turn(3, 6000)], "what turns 1 and 2 came to"),
    ];

    await runTurn();

    expect(sent.map((c) => c.type)).toContain("data-memory-consolidating");
  });

  it("says nothing of the sort on a turn that folds nothing", async () => {
    contexts.queue = [context([...turn(1, 2000), ...turn(2, 2000)])];

    await runTurn();

    expect(sent.map((c) => c.type)).not.toContain("data-memory-consolidating");
  });

  it("assembles a second time and sends that one", async () => {
    // T1: the reply this turn gets must see the memory the fold just wrote.
    // Sending the first assembly would drop those turns from the history
    // without putting anything in their place.
    contexts.queue = [
      context([...turn(1, 6000), ...turn(2, 6000), ...turn(3, 6000)]),
      context([...turn(3, 6000)], "what turns 1 and 2 came to"),
    ];

    await runTurn();

    expect(buildTurnContext).toHaveBeenCalledTimes(2);
    const lastAssembly = buildAgentConfig.mock.calls.at(-1)?.[0] as {
      memoryContext: { conversationMemory: string };
    };
    expect(lastAssembly.memoryContext.conversationMemory).toBe(
      "what turns 1 and 2 came to",
    );
  });

  it("reassembles even when the fold was discarded", async () => {
    // The window is gone either way, so the first assembly is stale either
    // way: it still holds turns the watermark has now passed.
    consolidateWindow.mockResolvedValue("discarded");
    contexts.queue = [
      context([...turn(1, 6000), ...turn(2, 6000), ...turn(3, 6000)]),
      context([...turn(3, 6000)]),
    ];

    await runTurn();

    expect(buildTurnContext).toHaveBeenCalledTimes(2);
  });

  it("reassembles when another request folded further first", async () => {
    // N8: the losing side's assembly was built from its own narrower window
    // and the memory as it stood before. Reading again is what picks up the
    // winner's watermark and the memory it wrote.
    consolidateWindow.mockResolvedValue("superseded");
    contexts.queue = [
      context([...turn(1, 6000), ...turn(2, 6000), ...turn(3, 6000)]),
      context([...turn(3, 6000)], "what the other tab wrote"),
    ];

    await runTurn();

    expect(buildTurnContext).toHaveBeenCalledTimes(2);
    const lastAssembly = buildAgentConfig.mock.calls.at(-1)?.[0] as {
      memoryContext: { conversationMemory: string };
    };
    expect(lastAssembly.memoryContext.conversationMemory).toBe(
      "what the other tab wrote",
    );
  });
});

describe("a turn the reader stopped", () => {
  it("starts no consolidating model call of its own", async () => {
    // T2: pressing stop must not spend a model call on bookkeeping the
    // reader will never see.
    const controller = new AbortController();
    controller.abort();
    contexts.queue = [
      context([...turn(1, 6000), ...turn(2, 6000), ...turn(3, 6000)]),
      context([...turn(3, 6000)]),
    ];

    await runTurn(controller.signal);

    for (const call of consolidateWindow.mock.calls) {
      const asked = call[0] as { signal?: AbortSignal };
      expect(asked.signal?.aborted).toBe(true);
    }
  });

  it("does not assemble again when the fold never ran", async () => {
    // Nothing moved: no summary, no watermark. Reading it all a second time
    // would spend three more round trips to arrive at what is already here.
    consolidateWindow.mockResolvedValue("aborted");
    contexts.queue = [
      context([...turn(1, 6000), ...turn(2, 6000), ...turn(3, 6000)]),
      context([...turn(3, 6000)]),
    ];

    await runTurn();

    expect(buildTurnContext).toHaveBeenCalledTimes(1);
  });
});
