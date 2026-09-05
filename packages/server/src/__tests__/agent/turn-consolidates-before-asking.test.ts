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
  vi.fn<
    (
      ...args: unknown[]
    ) => Promise<"written" | "discarded" | "superseded" | "aborted" | "untouched">
  >();
const chargeOnceForGeneration = vi.fn(async (..._args: unknown[]) => null);
const buildAgentConfig = vi.hoisted(() => vi.fn());

const thisCase = vi.hoisted(() => ({
  parts: [] as unknown[],
  endsOnItsOwn: true,
  /** What the model was actually handed, straight off the provider call. */
  sent: null as null | { prompt: unknown[]; tools: unknown },
}));

/** What `buildTurnContext` answers with, one call at a time. */
const contexts = vi.hoisted(() => ({
  queue: [] as unknown[],
  lastHistory: [] as never[],
  /** Answers once the queue is empty, for a case whose later reads depend on what the fold decided. */
  later: null as null | (() => unknown),
}));
const buildTurnContext = vi.fn(async () => {
  const next = (contexts.queue.shift() ?? contexts.later?.()) as { compressedHistory: never[] };
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
        doStream: async ({ prompt, tools }) => {
          thisCase.sent = { prompt, tools };
          return {
          stream: new ReadableStream({
              start(controller) {
                for (const part of thisCase.parts) controller.enqueue(part as never);
                controller.close();
              },
            }),
          };
        },
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
 * One turn whose weight is all in a tool result.
 *
 * `toMessageData` builds `content` out of text parts alone, so a tool result
 * is nowhere in the stored row's `content` and everywhere in what the turn
 * sends. A turn shaped like this is the one place the two rulers disagree.
 * @param turnIndex - The turn it belongs to.
 * @param size - How many characters the tool gave back.
 * @returns The user message and the reply.
 */
function toolTurn(turnIndex: number, size: number): MessageData[] {
  return [
    { role: "user", content: `q${turnIndex}`, parts: [{ type: "text", text: `q${turnIndex}` }], ts: "", turnIndex },
    {
      role: "assistant",
      content: "",
      parts: [
        {
          type: "tool",
          toolCallId: `call-${turnIndex}`,
          toolName: "web_search",
          input: { url: "https://example.test/page" },
          status: "success",
          output: "a".repeat(size),
        },
      ],
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
function context(history: MessageData[], conversationMemory = "", projectMemory = "") {
  return {
    memoryContext: { projectMemory, conversationMemory },
    compressedHistory: history,
    // Nothing folded yet, which is what a history starting at turn 1 means.
    watermark: 0,
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
      sent.push(chunk);
    }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  contexts.queue = [];
  contexts.later = null;
  // Cleared, so "the model was never called" means this case rather than any
  // case: what the previous one handed the model would otherwise be read as
  // this one's, and read as a pass.
  thisCase.sent = null;
  limits.budget = 20_000;
  limits.keep = 13_000;
  consolidateWindow.mockResolvedValue("written");
});

/**
 * What the assembly measures, by the ruler the budget is read with.
 *
 * The figure the implementation compares against its line, which is what a
 * case pinning the line itself needs: `instructions` is priced apart from
 * `messages`, and a provider is handed the two folded together.
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

/**
 * What the model was handed, measured the way the budget is measured.
 *
 * Read off the provider call rather than rebuilt from the assembly's inputs:
 * the thing N1 promises about is the request that goes out, and a turn that
 * folded and then sent its first assembly anyway would satisfy any figure
 * recomputed from those inputs.
 * @returns The length in characters of what was sent.
 */
async function sentLength(): Promise<number> {
  const { measureMessages } = await import("@server/agent/payload-size.js");
  const call = thisCase.sent;
  if (call === null) throw new Error("the model was never called");
  return measureMessages(call.prompt as never) + JSON.stringify(call.tools ?? []).length;
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
    // The loop runs to the keep line less the room the fold may take for
    // memory: 19,000 - (1,000 + 1,000) = 17,000. Taking the first leaves
    // 18,200 and the second leaves 12,200, the first figure under 17,000 —
    // so the third stays and the boundary is turn 2.
    limits.keep = 19_000;
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
    // Half of the billing key. Read off the assembly rather than looked up
    // again, so two tabs that took the same window derive the same key.
    expect(asked.watermarkBefore).toBe(0);

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
      context([], "what the whole conversation came to"),
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

  it("prices a turn by what it sends, so a tool-heavy one counts", async () => {
    // N1's third fixture. A tool result is absent from the stored row's
    // `content` and present in everything the turn sends. The first turn
    // alone is over the gap between the two lines, so taking it is enough.
    //
    // An implementation that adds up `content` reads that turn as two
    // characters: the loop then takes it, finds nothing has come down, and
    // goes on to take the rest of the conversation as well.
    contexts.queue = [
      context([...toolTurn(1, 18_000), ...turn(2, 500)]),
      context([...turn(2, 500)]),
    ];

    await runTurn();

    const folded = consolidateWindow.mock.calls[0]?.[0] as { newWatermark: number };
    expect(folded.newWatermark).toBe(1);
  });

  it("leaves the reassembled request under the keep line", async () => {
    // N1's headline, measured the way the budget is measured rather than by
    // repeating the planner's own subtraction. The second read answers with
    // whatever the fold decided to take, so this is the request that really
    // goes out.
    const history = [...turn(1, 6000), ...turn(2, 6000), ...turn(3, 6000)];
    contexts.queue = [context(history)];
    contexts.later = () => {
      const folded = consolidateWindow.mock.calls[0]?.[0] as { newWatermark: number };
      return context(history.filter((m) => m.turnIndex > folded.newWatermark));
    };

    await runTurn();

    expect(buildTurnContext).toHaveBeenCalledTimes(2);
    expect(await sentLength()).toBeLessThanOrEqual(limits.keep);
  });

  it("leaves room for the memory the fold is about to write", async () => {
    // The planner measures a payload whose memory sections are what they were
    // before the fold — on a conversation's first fold, absent entirely. The
    // fold then writes both layers, and the second assembly carries them. Take
    // turns until the pre-fold figure is under the line and the post-fold
    // request is over it by however much the memory grew.
    const { getAgentConfig } = await import("@breatic/core");
    const config = getAgentConfig();
    const history = [...turn(1, 6000), ...turn(2, 6000), ...turn(3, 6000)];
    contexts.queue = [context(history)];
    contexts.later = () => {
      const folded = consolidateWindow.mock.calls[0]?.[0] as { newWatermark: number };
      return context(
        history.filter((m) => m.turnIndex > folded.newWatermark),
        "c".repeat(config.memory_conversation_max_size),
        "p".repeat(config.memory_project_max_size),
      );
    };

    await runTurn();

    expect(await sentLength()).toBeLessThanOrEqual(limits.keep);
  });

  it("leaves room measured the way the payload is measured", async () => {
    // The ceilings are counted in code points, since that is where memory is
    // cut; the payload is measured in code units, since that is what a string
    // length is. A summary written in emoji — the prompt asks the model to
    // answer in the language of the conversation — is two code units per
    // character, so a reservation taken at face value is half of what the
    // memory actually adds.
    const { getAgentConfig } = await import("@breatic/core");
    const config = getAgentConfig();
    // Six small turns on a 15,000 budget, so the loop stops with what remains
    // just under the line rather than overshooting it: 18,200 assembled, and
    // taking four leaves 10,200 against a line of 11,000.
    limits.budget = 15_000;
    const history = [1, 2, 3, 4, 5, 6].flatMap((n) => turn(n, 2000));
    contexts.queue = [context(history)];
    contexts.later = () => {
      const folded = consolidateWindow.mock.calls[0]?.[0] as { newWatermark: number };
      return context(
        history.filter((m) => m.turnIndex > folded.newWatermark),
        "🎬".repeat(config.memory_conversation_max_size),
        "🎥".repeat(config.memory_project_max_size),
      );
    };

    await runTurn();

    expect(await sentLength()).toBeLessThanOrEqual(limits.keep);
  });

  it("answers the reader when the second assembly cannot be read", async () => {
    // The fold moved the watermark, so the window is gone from the history
    // whichever way it ended. Failing the turn here spends that window and
    // gives nothing back — and the reply is what was promised. The assembly
    // already in hand is the pre-fold one: over the character budget, inside
    // the model's real window, and the only thing left to send.
    contexts.queue = [context([...turn(1, 6000), ...turn(2, 6000), ...turn(3, 6000)])];
    contexts.later = () => {
      throw new Error("connection terminated unexpectedly");
    };

    await runTurn();

    expect(sent.some((chunk) => chunk.type === "text-delta")).toBe(true);
  });

  it.each(["discarded", "untouched"] as const)(
    "still answers the reader when the fold ends as %s",
    async (outcome) => {
      // N4's headline. Every other assertion about a failed fold is about the
      // watermark; this is the one about the reader, who asked a question and
      // is owed an answer whichever way the bookkeeping went.
      consolidateWindow.mockResolvedValue(outcome);
      contexts.queue = [
        context([...turn(1, 6000), ...turn(2, 6000), ...turn(3, 6000)]),
        context([...turn(3, 6000)]),
      ];

      await runTurn();

      expect(sent.some((chunk) => chunk.type === "text-delta")).toBe(true);
    },
  );

  it("does not reassemble when the fold never happened", async () => {
    // Nothing moved: the watermark is where the first assembly read it and
    // the history is the same history. Reading it again would return the
    // same thing at the cost of another round of queries.
    consolidateWindow.mockResolvedValue("untouched");
    contexts.queue = [context([...turn(1, 6000), ...turn(2, 6000), ...turn(3, 6000)])];

    await runTurn();

    expect(buildTurnContext).toHaveBeenCalledTimes(1);
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

    // The fold is reached and hands back straight away: its first line is the
    // signal check. Written as two statements rather than a loop over the
    // calls — a loop over an empty list is an assertion that never runs, so a
    // turn that skipped the fold entirely would read as a pass.
    expect(consolidateWindow).toHaveBeenCalledTimes(1);
    {
      const asked = consolidateWindow.mock.calls[0]?.[0] as { signal?: AbortSignal };
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
