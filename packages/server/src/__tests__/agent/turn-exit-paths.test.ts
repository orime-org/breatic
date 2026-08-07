// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Every way a turn can end emits an ending, and none of them keeps paying.
 *
 * The exits covered here: the stream finishing, a blocking interaction tool
 * stopping to ask, a provider failure, and the stream being torn down. Every
 * one owes the frontend a `chat_done` -- without it the UI has nothing to
 * switch out of its in-flight state. (The fourth exit, the client walking
 * away, lives in turn-cleanup-on-abort.test.ts along with what is measured
 * about how reachable it currently is.)
 *
 * Two of these are subtler than they look, and both were regressions this PR
 * introduced and then had to undo:
 *
 * Reading `result.usage` is not a passive read: in AI SDK 6.0.141 the getter
 * chains `usage` to `finalStep` to `steps`, and `steps` calls
 * `consumeStream()`. Awaiting it in a finally that a blocking tool just
 * returned through drives the model loop to completion -- the exact opposite
 * of what the sentinel exists to do, and billable output nobody asked for.
 *
 * And a failing provider does not throw. Measured on ai@6.0.141 with a model
 * whose `doStream` throws, the loop saw ["start","error"] and did not throw,
 * so a loop watching only for exceptions calls a dead turn a clean finish.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as CoreModule from "@breatic/core";
import type * as DomainModule from "@breatic/domain";

const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>) => 1);
const consolidateIfNeeded = vi.fn(async () => undefined);
const deductOnce = vi.fn(async (..._args: unknown[]) => undefined);
const streamTextRetry = vi.fn();
/** Set when the code under test reads `usage`, which is what consumes a stream. */
const usageRead = vi.fn();

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
    env: new Proxy(base.env as object, {
      get: (t, p: string) =>
        p === "BRAVE_SEARCH_API_KEY" ? "test-key" : Reflect.get(t, p),
    }),
  };
});

vi.mock("@breatic/domain", async () => {
  const { domainMock } = await import("../helpers/mock-core.js");
  const base = await domainMock();
  const actual = await vi.importActual<typeof DomainModule>("@breatic/domain");
  return {
    ...base,
    finalizeTurn: actual.finalizeTurn,
    streamTextRetry,
    // The real factory, not a stub. What a plain chat turn hands the model
    // is one of this PR's deliverables, and a stub returning `tools: {}`
    // would let the caller pass anything at all and still look right.
    buildAgentConfig: actual.buildAgentConfig,
    creditService: { deductOnce },
    resolveProvider: () => "test",
    getModel: () => "model",
  };
});

vi.mock("@server/modules", async (importOriginal) => {
  const { serverModulesMock } = await import("../helpers/mock-core.js");
  return serverModulesMock(importOriginal);
});
vi.mock("@server/modules/conversation/conversation.repo.js", () => ({ addMessage }));
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

/** Drive one turn to completion and collect its events. */
async function runTurn(): Promise<string[]> {
  const { MainAgent } = await import("@server/agent/main-agent.js");
  const { runWithContext } = await import("@breatic/core");
  const events: string[] = [];
  await runWithContext(
    {
      userId: "u1",
      conversationId: "c1",
      memoryContext: { userMemory: "", projectMemory: "", conversationMemory: "" },
      compressedHistory: [],
    },
    async () => {
      for await (const e of new MainAgent().chat("hi")) {
        events.push((e as { event: string }).event);
      }
    },
  );
  return events;
}

beforeEach(() => {
  [addMessage, consolidateIfNeeded, deductOnce, usageRead].forEach((m) => m.mockClear());
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

  it("marks the turn interactive, which is what keeps those four in", async () => {
    // The same six could arrive with `interactive` unset if the filter ever
    // stopped applying; this pins the reason rather than the outcome.
    streamTextRetry.mockReturnValue(streamOf([{ type: "text-delta", text: "hi" }]));
    await runTurn();
    const call = streamTextRetry.mock.calls[0]?.[0] as { tools: Record<string, unknown> };
    expect(Object.keys(call.tools)).toContain("ask_user_question");
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
    // The SDK does not throw when the provider fails. Measured on ai@6.0.141
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
