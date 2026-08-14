// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The stop reaches the model and the tool, not just the route.
 *
 * Every other test of this chain stands on a stubbed stream, which can say
 * anything at all — including that a turn stopped when nothing stopped it.
 * This one runs the real `streamText` against a model that counts how many
 * times it was asked to produce something, so "the model stopped" is measured
 * rather than asserted about a fixture.
 *
 * Two things are being measured, and they fail in different ways:
 *
 *   - the provider is not asked again. A loop that reads the stop but keeps
 *     stepping would still emit an ending, still bill, still look right, and
 *     quietly spend the user's credit on steps taken after they left.
 *   - the turn ends promptly. It cannot end before its tools do, so the whole
 *     bound rests on the tool letting go — measured on ai@7.0.58, a tool that
 *     ignores its signal held its turn for the full four seconds it ran, and
 *     one that honoured it ended in eight milliseconds.
 *
 * `web_fetch` is driven for real here rather than stood in for, because it is
 * the tool with the longest reach: a response body that never finishes is not
 * covered by the transport's deadline at all, and nothing short of the real
 * tool would show whether that path was wired.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type * as DomainModule from "@breatic/domain";

const dnsLookupMock = vi.fn();
vi.mock("@server/agent/turn-context.js", () => ({
  buildTurnContext: vi.fn(async () => ({
    memoryContext: { userMemory: "", projectMemory: "", conversationMemory: "" },
    compressedHistory: [],
  })),
}));
vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => dnsLookupMock(...args),
}));

/** How many times the provider was asked to produce a step. */
let providerCalls = 0;
/** What the provider says for each step, set per test. */
let providerParts: () => readonly Record<string, unknown>[];

const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>) => 1);
const consolidateIfNeeded = vi.fn(async () => undefined);
const deductOnce = vi.fn(async (..._args: unknown[]) => undefined);
/** The tools the turn is given, set per test. */
let turnTools: Record<string, unknown> = {};

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getAgentConfig: () => ({
      max_tool_iterations: 5,
      llm_max_retries: 0,
      full_detail_turns: 3,
      web_fetch_timeout_ms: 30_000,
      web_search_timeout_ms: 10_000,
      web_fetch_max_chars: 50_000,
    }),
    env: new Proxy({}, {
      get: (_t, p: string) => (p === "CREDIT_MULTIPLIER" ? 1 : undefined),
    }),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  const { MockLanguageModelV4 } = await import("ai/test");
  return {
    ...actual,
    // Real: this is what is under test.
    streamTextRetry: actual.streamTextRetry,
    finalizeTurn: actual.finalizeTurn,
    getModel: () =>
      new MockLanguageModelV4({
        doStream: async () => {
          providerCalls += 1;
          return {
            stream: new ReadableStream({
              start(controller) {
                for (const part of providerParts()) {
                  // The parts are written out by hand below, in the shapes the
                  // SDK sends. Its own union of those shapes is not re-exported
                  // from `ai`, and reaching into `@ai-sdk/provider` for it
                  // would mean this package declaring a dependency it does not
                  // have — for a type, in a test.
                  controller.enqueue(part as never);
                }
                controller.close();
              },
            }),
          };
        },
      }),
    resolveProvider: () => "test",
    buildAgentConfig: () => ({
      modelId: "test/model",
      instructions: "system",
      tools: turnTools,
    }),
    creditService: { deductOnce },
  };
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
vi.mock("@server/agent/memory-consolidator.js", () => ({ consolidateIfNeeded }));
vi.mock("@server/agent/context.js", () => ({ buildSystemPrompt: () => "system" }));

const fetchMock = vi.fn();

/** A first step that calls one tool and would be followed by a second step. */
function callsTool(toolName: string): readonly Record<string, unknown>[] {
  return [
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: "call-1",
      toolName,
      input: JSON.stringify({ url: "https://public.example/page" }),
    },
    {
      type: "finish",
      finishReason: "tool-calls",
      usage: { inputTokens: 5, outputTokens: 5, totalTokens: 300 },
    },
  ];
}

/**
 * Drive one turn and report how long it took to end.
 * @param signal - The turn's cancellation signal.
 * @returns Milliseconds from first event to last.
 */
async function timeTurn(signal: AbortSignal): Promise<number> {
  const { MainAgent } = await import("@server/agent/main-agent.js");
  const { runWithContext } = await import("@breatic/core");
  const started = Date.now();
  await runWithContext(
    {
      userId: "u1",
      conversationId: "c1",
      projectId: "p1",
    },
    async () => {
      for await (const _event of new MainAgent().chat("hi", undefined, signal)) {
        // Drained: the route writes these out; here only the timing matters.
      }
    },
  );
  return Date.now() - started;
}

beforeEach(() => {
  providerCalls = 0;
  providerParts = () => [];
  turnTools = {};
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  dnsLookupMock.mockReset();
  dnsLookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  [addMessage, consolidateIfNeeded, deductOnce].forEach((m) => m.mockClear());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a stopped turn stops the model", () => {
  it("does not ask the provider again, and stays that way", async () => {
    // The turn is stopped while a tool is running, which is the moment the
    // loop is between steps: the first step is finished with the provider and
    // the second has not started. A loop that read the stop and stepped on
    // anyway would show up here as a second call.
    const { tool } = await import("ai");
    const { z } = await import("zod");
    const stopped = new AbortController();

    turnTools = {
      slow_tool: tool({
        description: "waits",
        inputSchema: z.object({ url: z.string() }),
        execute: async (_input, options: { abortSignal?: AbortSignal }) =>
          new Promise<string>((resolve) => {
            const timer = setTimeout(() => resolve("finished on its own"), 4_000);
            options.abortSignal?.addEventListener("abort", () => {
              clearTimeout(timer);
              resolve("let go");
            });
          }),
      }),
    };
    providerParts = () => callsTool("slow_tool");

    setTimeout(() => stopped.abort(new Error("user pressed stop")), 100);
    await timeTurn(stopped.signal);

    expect(providerCalls).toBe(1);
    // Five seconds, which is past the four the tool would have run for had
    // nothing stopped it: a turn that merely looked stopped would have taken
    // its second step by now.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    expect(providerCalls).toBe(1);
  }, 30_000);

  it("ends within a second of the stop, with web_fetch waiting on a body", async () => {
    // The longest reach any tool has: the transport handed back a response
    // and cleared its deadline, and the body never finishes arriving. Nothing
    // between the route and this read can end the turn.
    // Through the same factory production uses, so the tool under test is the
    // one a real turn would be given.
    const { buildToolSet } = await import("@breatic/domain");
    const stopped = new AbortController();

    turnTools = buildToolSet(["web_fetch"]);
    providerParts = () => callsTool("web_fetch");
    // The body errors when the request's signal is raised, which is what a
    // real `fetch` does. A stub that leaves that out would have the read hang
    // forever and would say nothing about whether the chain works.
    fetchMock.mockImplementation((_url: string, init: { signal?: AbortSignal }) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("the beginning of a page"));
              init.signal?.addEventListener("abort", () => {
                controller.error(init.signal?.reason ?? new Error("aborted"));
              });
            },
          }),
          { status: 200, headers: { "content-type": "text/plain" } },
        ),
      ),
    );

    setTimeout(() => stopped.abort(new Error("user pressed stop")), 100);
    const elapsed = await timeTurn(stopped.signal);

    // From the stop, not from the start of the turn.
    expect(elapsed - 100).toBeLessThan(1_000);
    expect(providerCalls).toBe(1);
  }, 30_000);

  it("ends within a second of the stop, with web_fetch waiting on a connection", async () => {
    // The other way a page stalls, and the one the transport does cover. Both
    // are asserted because a chain wired for only one of them passes the other
    // test and leaves the real hazard in place.
    // Through the same factory production uses, so the tool under test is the
    // one a real turn would be given.
    const { buildToolSet } = await import("@breatic/domain");
    const stopped = new AbortController();

    turnTools = buildToolSet(["web_fetch"]);
    providerParts = () => callsTool("web_fetch");
    fetchMock.mockImplementation(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    setTimeout(() => stopped.abort(new Error("user pressed stop")), 100);
    const elapsed = await timeTurn(stopped.signal);

    expect(elapsed - 100).toBeLessThan(1_000);
    expect(providerCalls).toBe(1);
  }, 30_000);
});
