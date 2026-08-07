// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Every way a turn can end emits an ending, and none of them keeps paying.
 *
 * Four exits: the stream finishing, a blocking interaction tool stopping to
 * ask, the model throwing, and the client walking away. The first three all
 * owe the frontend a `chat_done` -- without it the UI has nothing to switch
 * out of its in-flight state.
 *
 * The second assertion is the subtler one and it is a regression this PR
 * introduced. Reading `result.usage` is not a passive read: in AI SDK
 * 6.0.141 the getter chains `usage` to `finalStep` to `steps`, and `steps`
 * calls `consumeStream()`. So awaiting usage inside a finally that a blocking
 * tool just returned through drives the model loop to completion -- the exact
 * opposite of what the sentinel exists to do, and billable tokens for output
 * nobody asked for.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as CoreModule from "@breatic/core";
import type * as DomainModule from "@breatic/domain";

const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>) => 1);
const consolidateIfNeeded = vi.fn(async () => undefined);
const deductOnce = vi.fn(async () => undefined);
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
    buildAgentConfig: () => ({ modelId: "m", instructions: "s", tools: {} }),
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

  it("ends with error and chat_done when the model throws", async () => {
    streamTextRetry.mockReturnValue({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "partial" };
        throw new Error("provider exploded");
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
