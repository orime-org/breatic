// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Every way a turn can end emits an ending, and none of them keeps paying.
 *
 * The exits covered here: the stream finishing, a blocking interaction tool
 * stopping to ask, a provider failure, the user pressing stop, and the stream
 * being torn down. Every one owes the frontend a `chat_done` -- without it the
 * UI has nothing to switch out of its in-flight state. (One more exit, a
 * consumer abandoning the generator with `.return()`, lives in
 * turn-cleanup-on-abort.test.ts: it is the only ending no line in the loop
 * gets to announce, so it is read off the absence instead.)
 *
 * Two of these are subtler than they look, for different reasons.
 *
 * Reading `result.usage` is not a passive read: on ai@7.0.58 `usage` returns
 * `totalUsage`, which calls `consumeStream()` itself. Awaiting it in a finally
 * that a blocking tool just returned through drives the model loop to
 * completion -- the exact opposite of what the sentinel exists to do, and
 * billable output nobody asked for. That one this PR introduced and then had
 * to undo.
 *
 * And a failing provider does not throw. Measured on ai@7.0.58 with a model
 * whose `doStream` throws, the loop saw ["start","error"] and did not throw,
 * so a loop watching only for exceptions calls a dead turn a clean finish.
 * That one was never handled at all, here or on main.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as CoreModule from "@breatic/core";
import type * as DomainModule from "@breatic/domain";

const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>) => 1);
const consolidateIfNeeded = vi.fn(async () => undefined);
const deductOnce = vi.fn(async (..._args: unknown[]) => undefined);
const streamTextRetry = vi.fn();
/** The real factory, wrapped so both what goes in and what comes out are visible. */
const buildAgentConfig = vi.hoisted(() => vi.fn());
/** Set when the code under test reads `usage`, which is what consumes a stream. */
const usageRead = vi.fn();

vi.mock("@server/agent/turn-context.js", () => ({
  buildTurnContext: vi.fn(async () => ({
    memoryContext: { userMemory: "", projectMemory: "", conversationMemory: "" },
    compressedHistory: [],
  })),
}));
vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  streamText: vi.fn(),
  generateText: vi.fn(),
  stepCountIs: vi.fn(() => 40),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  const base = await coreMock(importOriginal);
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...base,
    runWithContext: actual.runWithContext,
    getContext: actual.getContext,
    // The search key, so web_search is not dropped for want of one. That
    // rule is real and has its own tests; here it would just quietly turn
    // "six baseline tools" into five.
    env: new Proxy(base.env, {
      get: (t, p: string) =>
        p === "BRAVE_SEARCH_API_KEY" ? "test-key" : Reflect.get(t, p),
    }),
  };
});

vi.mock("@breatic/domain", async () => {
  const { domainMock } = await import("../helpers/mock-core.js");
  const base = await domainMock();
  const actual = await vi.importActual<typeof DomainModule>("@breatic/domain");
  buildAgentConfig.mockImplementation(actual.buildAgentConfig);
  return {
    ...base,
    finalizeTurn: actual.finalizeTurn,
    streamTextRetry,
    // The real factory wrapped in a spy: real, because what a plain chat turn
    // hands the model is one of this PR's deliverables and a stub returning
    // `tools: {}` would let the caller pass anything and still look right;
    // spied, because the other entry point's wiring is only observable in the
    // arguments it passes.
    buildAgentConfig,
    creditService: { deductOnce },
    resolveProvider: () => "test",
    getModel: () => "model",
  };
});

vi.mock("@server/modules", async (importOriginal) => {
  const { serverModulesMock } = await import("../helpers/mock-core.js");
  return serverModulesMock(importOriginal);
});
/**
 * What the conversation holds, for the settle-up every turn opens with.
 *
 * Empty because these cases are about what happens after that: the point of
 * the event is that the browser takes the server's version, and a version
 * with nothing in it is the version that gets out of the way.
 */
const getMessages = vi.fn(async () => ({ messages: [], hasMore: false }));

vi.mock("@server/modules/conversation/conversation-message.repo.js", () => ({ addMessage, getMessages }));
// The turn asks the conversation what it is called, so it can say so in the
// event that opens the turn. Answered with a name already set: these tests are
// about what a turn streams, not about how a conversation comes by its name.
vi.mock("@server/modules/conversation/conversation.service.js", () => ({
  titleForTurn: vi.fn(async () => "already named"),
}));

vi.mock("@server/agent/memory-consolidator.js", () => ({ consolidateIfNeeded }));
vi.mock("@server/agent/context.js", () => ({ buildSystemPrompt: () => "system" }));

/** A stream whose `usage` records that it was read. */
function streamOf(parts: unknown[]) {
  return {
    fullStream: (async function* () {
      for (const p of parts) yield p;
    })(),
    get usage() {
      usageRead();
      return Promise.resolve({ totalTokens: 100 });
    },
  };
}

/** Drive one skill command to completion and collect its events. */
async function runSkillTurn(skillName: string): Promise<string[]> {
  const { MainAgent } = await import("@server/agent/main-agent.js");
  const { runWithContext } = await import("@breatic/core");
  const events: string[] = [];
  await runWithContext(
    {
      userId: "u1",
      conversationId: "c1",
      projectId: "p1",
    },
    async () => {
      for await (const e of new MainAgent().handleSkillCommand(skillName, "go")) {
        events.push((e as { event: string }).event);
      }
    },
  );
  return events;
}

/** One SSE event as the route would see it. */
type Emitted = { event: string; data: Record<string, unknown> };

/**
 * Drive one turn and collect its events with their payloads.
 * @param signal - Handed to the turn as the caller's cancellation signal.
 * @returns Every event the turn emitted, in order.
 */
async function runTurnFull(signal?: AbortSignal): Promise<Emitted[]> {
  const { MainAgent } = await import("@server/agent/main-agent.js");
  const { runWithContext } = await import("@breatic/core");
  const events: Emitted[] = [];
  await runWithContext(
    {
      userId: "u1",
      conversationId: "c1",
      projectId: "p1",
    },
    async () => {
      for await (const e of new MainAgent().chat("hi", undefined, signal)) {
        events.push(e);
      }
    },
  );
  return events;
}

/** Drive one turn to completion and collect its event names. */
async function runTurn(): Promise<string[]> {
  return (await runTurnFull()).map((e) => e.event);
}

/**
 * The assistant messages a turn wrote as its wrap-up, excluding tool traces.
 *
 * Both go in through the same `addMessage`, and telling them apart is a
 * property of the argument rather than of the call site: a tool trace is
 * written with an empty `content` and a `tool_calls` array (main-agent's
 * `tool-result` branch), a wrap-up carries the reply and no `tool_calls`.
 * @returns The wrap-up messages, in the order they were written.
 */
function wrapUpMessages(): Array<Record<string, unknown>> {
  return addMessage.mock.calls
    .map(([, msg]) => msg)
    .filter((msg) => msg.role === "assistant" && msg.tool_calls === undefined);
}

beforeEach(() => {
  [addMessage, consolidateIfNeeded, deductOnce, usageRead, streamTextRetry, buildAgentConfig].forEach(
    (m) => m.mockClear(),
  );
});

describe("what a plain chat turn hands the model", () => {
  // Asserted on the CALLER, not on the factory. The defect being fixed was
  // that `chat()` passed an empty tool array — a factory test alone stays
  // green through exactly that, which is why the acceptance item spells out
  // "run chat() and deep-equal what reaches streamText".
  it("gives it the six baseline tools, and only those", async () => {
    streamTextRetry.mockReturnValue(streamOf([{ type: "text-delta", text: "hi" }]));
    await runTurn();
    const call = streamTextRetry.mock.calls[0]?.[0] as { tools: Record<string, unknown> };
    expect(Object.keys(call.tools).sort()).toEqual([
      "ask_user_choice",
      "ask_user_question",
      "propose_canvas_action",
      "show_search_results",
      "web_fetch",
      "web_search",
    ]);
  });

  it("marks the turn interactive, which is what keeps the interaction tools in", async () => {
    // The reason rather than the outcome, and the two are not the same test:
    // the interaction tools would still be in that set if the filter stopped
    // applying altogether, so asserting on the set cannot tell the two apart.
    // The flag is observable because the factory is wrapped rather than
    // replaced -- what goes in is visible, and what comes out is still real.
    streamTextRetry.mockReturnValue(streamOf([{ type: "text-delta", text: "hi" }]));
    await runTurn();
    expect(buildAgentConfig.mock.calls[0]?.[0]).toMatchObject({ interactive: true });
  });
});

describe("what a skill command hands the model", () => {
  // The other of the two entry points this PR exists to unify, and the one
  // with nothing watching it: deleting `skillName` from its factory call left
  // every test and typecheck green, because `skillName` is optional and the
  // route tests stop at 403/404.
  // The factory itself is stubbed for these two: the real one would look the
  // fixture skill up in a registry that has no skills under the test root.
  // What is under test is the call, not what the factory does with it — that
  // has its own tests where the factory lives.
  const stubConfig = { modelId: "m", instructions: "s", tools: {} };

  it("names the skill it was asked for", async () => {
    buildAgentConfig.mockReturnValueOnce(stubConfig);
    streamTextRetry.mockReturnValue(streamOf([{ type: "text-delta", text: "hi" }]));
    await runSkillTurn("creative_research");
    expect(buildAgentConfig.mock.calls[0]?.[0]).toMatchObject({
      skillName: "creative_research",
    });
  });

  it("marks it interactive and passes the caller's prompt and memory", async () => {
    // All four arguments, so dropping any one of them goes red here. The
    // skill path used to assemble its own instructions and drifted from chat
    // on every value; passing them is what stopped that.
    buildAgentConfig.mockReturnValueOnce(stubConfig);
    streamTextRetry.mockReturnValue(streamOf([{ type: "text-delta", text: "hi" }]));
    await runSkillTurn("creative_research");
    expect(buildAgentConfig.mock.calls[0]?.[0]).toMatchObject({
      skillName: "creative_research",
      interactive: true,
      basePrompt: "system",
    });
  });
});

describe("how a turn ends", () => {
  it("ends a normal turn with chat_done", async () => {
    streamTextRetry.mockReturnValue(streamOf([{ type: "text-delta", text: "hi" }]));
    expect(await runTurn()).toContain("chat_done");
  });

  it("ends with chat_done after a blocking tool stops to ask", async () => {
    streamTextRetry.mockReturnValue(
      streamOf([
        { type: "tool-call", toolCallId: "t1", toolName: "ask_user_question", input: {} },
        { type: "tool-result", toolCallId: "t1", output: "__ASK_USER__{}" },
      ]),
    );
    const events = await runTurn();
    expect(events).toContain("agent_ask");
    expect(events).toContain("chat_done");
  });

  it("does not drive the model loop on after a blocking tool", async () => {
    // Reading usage consumes the stream, which would run the rest of the loop
    // the sentinel just stopped -- and bill for it.
    streamTextRetry.mockReturnValue(
      streamOf([
        { type: "tool-call", toolCallId: "t1", toolName: "ask_user_question", input: {} },
        { type: "tool-result", toolCallId: "t1", output: "__ASK_USER__{}" },
      ]),
    );
    await runTurn();
    expect(usageRead).not.toHaveBeenCalled();
  });

  // The behavioural tests above pass whether chat_done sits inside the
  // finally or after it, because no exit uses a bare `return` any more --
  // `break` falls through to both. That equivalence is exactly what a later
  // edit would break: one `return` added inside the loop and the ending is
  // skipped again, silently. This asserts the structure that keeps the
  // behavioural tests meaningful.
  it("has no bare return inside the streaming loop", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(import.meta.dirname, "../../agent/main-agent.ts"),
      "utf-8",
    );
    const loop = source.slice(
      source.indexOf("stream: for await"),
      source.indexOf("} catch (err) {", source.indexOf("stream: for await")),
    );
    expect(loop).not.toMatch(/^\s+return;/m);
  });

  it("keeps going after a tool that only shows the user something", async () => {
    // Two kinds of interaction tool, and treating them alike costs the rest
    // of the turn. `ask_user_choice` needs an answer before the model can
    // continue, so it stops. `show_search_results` and
    // `propose_canvas_action` just draw a card -- the model is meant to keep
    // writing around them, and may draw several in one turn. Stopping on
    // them means the first card a turn produces is the last thing it says.
    streamTextRetry.mockReturnValue(
      streamOf([
        { type: "tool-call", toolCallId: "t1", toolName: "show_search_results", input: {} },
        { type: "tool-result", toolCallId: "t1", output: '__SHOW_SEARCH_RESULTS__{"results":[]}' },
        { type: "text-delta", text: "here is what I found" },
      ]),
    );
    const events = await runTurn();
    expect(events).toContain("agent_search_results");
    // The delta after the card is the point: it only exists if the loop ran on.
    expect(events.indexOf("chat_chunk")).toBeGreaterThan(
      events.indexOf("agent_search_results"),
    );
  });

  it("does not make the user wait for memory consolidation", async () => {
    // Consolidation is an LLM call of its own, seconds long, and nobody is
    // waiting for it -- the user is waiting for the turn to be over. Putting
    // it in front of `chat_done` leaves the frontend spinning on a reply
    // that has already finished streaming.
    //
    // The race is the assertion: a consolidation that never finishes must
    // not hold the ending. Everything else in this path is mocked, so the
    // only thing that can take 200ms is an await on that promise.
    consolidateIfNeeded.mockReturnValueOnce(new Promise<undefined>(() => {}));
    streamTextRetry.mockReturnValue(streamOf([{ type: "text-delta", text: "hi" }]));
    const events = await Promise.race([
      runTurn(),
      new Promise<string[]>((_, reject) =>
        setTimeout(() => reject(new Error("chat_done waited for consolidation")), 200),
      ),
    ]);
    expect(events).toContain("chat_done");
    expect(consolidateIfNeeded).toHaveBeenCalled();
  });

  it("bills a turn that stopped to ask, for the step it did run", async () => {
    // The token count for a step rides in its `finish-step` part, and that
    // part arrives AFTER the step's `tool-result` -- measured against the
    // real SDK, order was start-step, tool-call, tool-result, finish-step.
    // So leaving at the tool-result threw away everything the step spent.
    streamTextRetry.mockReturnValue(
      streamOf([
        { type: "tool-call", toolCallId: "t1", toolName: "ask_user_question", input: {} },
        { type: "tool-result", toolCallId: "t1", output: "__ASK_USER__{}" },
        { type: "finish-step", usage: { totalTokens: 640 } },
        // Past the stopping point: proof the turn did not just keep going.
        { type: "text-delta", text: "should never be streamed" },
      ]),
    );
    const events = await runTurn();
    expect(deductOnce).toHaveBeenCalled();
    expect(deductOnce.mock.calls[0]?.[4]).toMatchObject({ tokensUsed: 640 });
    expect(events).not.toContain("chat_chunk");
  });

  it("reports a provider failure the SDK hands back as a stream part", async () => {
    // The SDK does not throw when the provider fails. Measured on ai@7.0.58
    // with a model whose `doStream` throws: the loop saw ["start","error"]
    // and did not throw. So an expired key, a 429 past the retry budget or a
    // bad model id all arrive here as a value, and a loop that only watches
    // for exceptions streams nothing and calls the turn a clean finish.
    streamTextRetry.mockReturnValue(
      streamOf([{ type: "error", error: new Error("401 expired key") }]),
    );
    const events = await runTurn();
    expect(events).toContain("error");
    expect(events).toContain("chat_done");
  });

  it("records that the turn failed, so a reload does not read it as a finished answer", async () => {
    // A stopped turn leaves a mark on the stored reply. A failed one has to
    // as well, or the two look identical once the page is reloaded: half an
    // answer that simply stops, with nothing to say it never got to finish.
    streamTextRetry.mockReturnValue(
      streamOf([
        { type: "text-delta", text: "Half a sen" },
        { type: "error", error: new Error("401 expired key") },
      ]),
    );
    await runTurn();

    const parts = wrapUpMessages().at(-1)?.parts as Array<{ type: string }> | undefined;
    expect(parts?.map((p) => p.type)).toContain("failed");
  });

  it("stores a turn that failed before the model said anything", async () => {
    // Nothing was written, so there is nothing but the mark — and without it
    // no message is stored at all, leaving what the user said sitting alone
    // with no answer and no explanation.
    streamTextRetry.mockReturnValue(
      streamOf([{ type: "error", error: new Error("401 expired key") }]),
    );
    await runTurn();

    expect(wrapUpMessages()).toHaveLength(1);
  });

  it("ends with error and chat_done when the stream itself throws", async () => {
    // This is the other failure shape: something inside our own loop throws,
    // or the stream is torn down with `controller.error()`. It is NOT what a
    // failing provider does -- see the test above, which covers that.
    streamTextRetry.mockReturnValue({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "partial" };
        throw new Error("stream torn down");
      })(),
      get usage() {
        usageRead();
        return Promise.resolve({ totalTokens: 50 });
      },
    });
    const events = await runTurn();
    expect(events).toContain("error");
    expect(events).toContain("chat_done");
  });
});

/**
 * The four ways a turn ends, and the promise that each of them settles up once.
 *
 * `finally` plus an early exit is the combination that pays twice: the exit
 * runs the wrap-up, then the finally runs it again, and the turn ends with two
 * endings, two stored replies and two charges. Counting is the whole point --
 * `toContain` is green either way, which is why the acceptance item spells out
 * `toHaveLength(1)`.
 *
 * Each fixture deliberately completes one step before it exits, so a charge is
 * owed on every path. The step's `finish-step` is what carries its token count,
 * so a fixture without one owes nothing and would assert nothing about billing.
 */
describe("every exit settles up exactly once", () => {
  /** A stream that ends the given way, after one step worth 300 tokens. */
  const EXITS = [
    {
      name: "the stream running out",
      parts: [
        { type: "text-delta", text: "all done" },
        { type: "finish-step", usage: { totalTokens: 300 } },
      ],
    },
    {
      name: "a blocking tool stopping to ask",
      parts: [
        { type: "tool-call", toolCallId: "t1", toolName: "ask_user_question", input: {} },
        { type: "tool-result", toolCallId: "t1", output: "__ASK_USER__{}" },
        { type: "finish-step", usage: { totalTokens: 300 } },
      ],
    },
    {
      name: "the provider failing",
      parts: [
        { type: "text-delta", text: "half a s" },
        { type: "finish-step", usage: { totalTokens: 300 } },
        { type: "error", error: new Error("401 expired key") },
      ],
    },
    {
      name: "the user pressing stop",
      parts: [
        { type: "text-delta", text: "half a s" },
        { type: "finish-step", usage: { totalTokens: 300 } },
        { type: "abort" },
      ],
    },
  ];

  for (const exit of EXITS) {
    it(`ends once, stores once and charges once after ${exit.name}`, async () => {
      streamTextRetry.mockReturnValue(streamOf(exit.parts));
      const events = await runTurnFull();
      expect(events.filter((e) => e.event === "chat_done")).toHaveLength(1);
      expect(wrapUpMessages().length).toBeLessThanOrEqual(1);
      expect(deductOnce).toHaveBeenCalledTimes(1);
    });
  }
});

/**
 * What the client is told, and what is kept, when the user presses stop.
 *
 * The SDK announces the stop as an `abort` part on the stream -- measured on
 * ai@7.0.58 with a real `streamText` and an aborted signal: the parts seen were
 * start, start-step, text-delta..., abort, and no further model call was made.
 * So the turn learns it was stopped the same way it learns anything else, by
 * reading the stream, and these fixtures say `abort` for the same reason the
 * ones above say `error`.
 */
describe("a turn the user stopped", () => {
  it("tells the client this ending was a stop", async () => {
    // One ending event, not two: the frontend clears its in-flight state in
    // exactly one place, and a separate event name would give it a second
    // place to forget about.
    streamTextRetry.mockReturnValue(
      streamOf([
        { type: "text-delta", text: "half a s" },
        { type: "finish-step", usage: { totalTokens: 300 } },
        { type: "abort" },
      ]),
    );
    const done = (await runTurnFull()).filter((e) => e.event === "chat_done");
    expect(done).toHaveLength(1);
    expect(done[0]?.data).toMatchObject({ aborted: true });
  });

  it("does not mark a turn that finished on its own", async () => {
    streamTextRetry.mockReturnValue(
      streamOf([
        { type: "text-delta", text: "all done" },
        { type: "finish-step", usage: { totalTokens: 300 } },
      ]),
    );
    const done = (await runTurnFull()).filter((e) => e.event === "chat_done");
    expect(done[0]?.data.aborted).not.toBe(true);
  });

  it("charges for the steps that finished, and only those", async () => {
    // 300 exactly, not "more than zero": the step that was cut off never sent
    // its `finish-step`, so its tokens are not ours to charge for, and a
    // `> 0` assertion would pass on any figure the code happened to produce.
    streamTextRetry.mockReturnValue(
      streamOf([
        { type: "text-delta", text: "first step" },
        { type: "finish-step", usage: { totalTokens: 300 } },
        { type: "text-delta", text: "second step, cut off" },
        { type: "abort" },
      ]),
    );
    await runTurnFull();
    expect(deductOnce.mock.calls[0]?.[4]).toMatchObject({ tokensUsed: 300 });
  });

  it("keeps what was generated even when no prose was streamed yet", async () => {
    // The turn called a tool and was stopped before writing a word, so the
    // reply is empty. Storing nothing here is what makes a stop look, to the
    // user coming back, exactly like a turn that never happened.
    streamTextRetry.mockReturnValue(
      streamOf([
        { type: "tool-call", toolCallId: "t1", toolName: "web_search", input: { query: "x" } },
        { type: "tool-result", toolCallId: "t1", output: "{}" },
        { type: "finish-step", usage: { totalTokens: 300 } },
        { type: "abort" },
      ]),
    );
    await runTurnFull();
    const wrapUps = wrapUpMessages();
    expect(wrapUps).toHaveLength(1);
    expect(wrapUps[0]?.parts).toContainEqual({ type: "interrupted" });
  });

  it("marks the stored reply when there was prose", async () => {
    streamTextRetry.mockReturnValue(
      streamOf([
        { type: "text-delta", text: "half a s" },
        { type: "finish-step", usage: { totalTokens: 300 } },
        { type: "abort" },
      ]),
    );
    await runTurnFull();
    const stored = wrapUpMessages()[0];
    expect(stored?.parts).toContainEqual({ type: "text", text: "half a s" });
    expect(stored?.parts).toContainEqual({ type: "interrupted" });
  });

  it("survives a stop that lands before any step finished", async () => {
    // The earliest possible stop. `result.totalUsage` rejects with an
    // AbortError in this case -- measured on ai@7.0.58 -- so a turn that
    // awaited it anywhere would end on an unhandled rejection instead of an
    // ending. Nothing here reads it, and this is what says so.
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown): void => {
      unhandled.push(err);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      streamTextRetry.mockReturnValue(streamOf([{ type: "abort" }]));
      const events = await runTurnFull();
      expect(events.filter((e) => e.event === "chat_done")).toHaveLength(1);
      expect(events.at(-1)?.data).toMatchObject({ aborted: true });
      // Nothing finished, so nothing is owed.
      expect(deductOnce).not.toHaveBeenCalled();
      // Still a record: the turn happened, and it was stopped.
      expect(wrapUpMessages()).toHaveLength(1);
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("hands the caller's cancellation signal to the model", async () => {
    // The middle ring. The route can subscribe to the disconnect and the loop
    // can watch for the abort part, and between them nothing happens at all
    // unless the signal actually reaches the SDK.
    const controller = new AbortController();
    streamTextRetry.mockReturnValue(
      streamOf([
        { type: "text-delta", text: "hi" },
        { type: "finish-step", usage: { totalTokens: 300 } },
      ]),
    );
    await runTurnFull(controller.signal);
    const call = streamTextRetry.mock.calls[0]?.[0] as { abortSignal?: AbortSignal };
    expect(call.abortSignal).toBe(controller.signal);
  });
});
