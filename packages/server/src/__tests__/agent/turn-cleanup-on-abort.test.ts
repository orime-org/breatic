// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * A turn's obligations survive its consumer walking away mid-stream.
 *
 * `gen.return()` is what any consumer that stops reading does -- it is the
 * language's own mechanism, and it stops the generator where it was
 * suspended, skipping every line after the loop. That is the defect the
 * turn-finalizer exists for, and this asserts the cleanup runs anyway.
 *
 * This is not how a browser disconnect arrives, and never was. Measured on the
 * repo's own hono 4.12.23 and @hono/node-server 2.0.4: `StreamingApi.write`
 * catches and discards the error a dead socket produces, so the route's
 * `for await` keeps going and never calls `.return()` — a probe had the
 * generator 357 iterations further along two seconds after the client left,
 * with `finally` never entered. A disconnect now travels the other way, by
 * `s.onAbort` raising the turn's signal so the SDK ends the stream and the
 * loop leaves through its own `abort` branch; `routes/chat.stop.test.ts`
 * covers that ring and `turn-exit-paths.test.ts` covers what the turn then
 * owes.
 *
 * What is left here is the language's own mechanism, which any consumer that
 * stops reading still triggers, and which no route wiring can rule out.
 *
 * MainAgent had no tests at all before this one, which is how the original
 * defect survived -- every test was green the whole time.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SSE_EVENT_NAMES } from "@breatic/shared";
import type * as CoreModule from "@breatic/core";
import type * as DomainModule from "@breatic/domain";

const addMessage = vi.fn(
  async (_id: string, _msg: Record<string, unknown>) => 1,
);
const consolidateIfNeeded = vi.fn(async () => undefined);
const deductOnce = vi.fn(async (..._args: unknown[]) => undefined);
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

/** The stream MainAgent will consume. Set per test. */
const streamTextRetry = vi.fn();

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  const base = await coreMock(importOriginal);
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...base,
    // The shared mock stubs runWithContext into a plain call, which never
    // establishes the AsyncLocalStorage store MainAgent reads from. This
    // test is specifically about behaviour inside that store, so it uses
    // the real pair.
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
    // The finalizer itself is the real one — mocking it would test the mock.
    finalizeTurn: actual.finalizeTurn,
    // main-agent calls domain's retry wrapper, not the SDK directly.
    streamTextRetry,
    buildAgentConfig: () => ({
      modelId: "test/model",
      instructions: "sys",
      tools: {},
    }),
    creditService: { deductOnce },
    resolveProvider: () => "test",
    getModel: () => "model",
  };
});

vi.mock("@server/modules", async (importOriginal) => {
  const { serverModulesMock } = await import("../helpers/mock-core.js");
  return serverModulesMock(importOriginal);
});

// These three are what the turn owes, and each is imported from its own
// module rather than through a barrel, so each is stubbed where it lives.
/**
 * What the conversation holds, for the settle-up every turn opens with.
 *
 * Empty because these cases are about what happens after that: the point of
 * the event is that the browser takes the server's version, and a version
 * with nothing in it is the version that gets out of the way.
 */
const getMessages = vi.fn(async () => ({ messages: [], hasMore: false }));

vi.mock("@server/modules/conversation/conversation-message.repo.js", () => ({
  addMessage, getMessages }));

vi.mock("@server/agent/memory-consolidator.js", () => ({
  consolidateIfNeeded,
}));

// What the prompt says is not what this test is about.
vi.mock("@server/agent/context.js", () => ({
  buildSystemPrompt: () => "system",
}));

beforeEach(() => {
  [addMessage, consolidateIfNeeded, deductOnce, usageRead].forEach((m) => m.mockClear());
});

describe("a turn cut short by the client", () => {
  it("still saves, consolidates and bills — without touching `usage`", async () => {
    // The billing figure has to come off the stream as it goes past, not
    // from `result.usage` at the end. That getter is not a passive read: on
    // ai@7.0.58 `usage` returns `totalUsage`, and `totalUsage` calls
    // `consumeStream()` itself. Reading it here -- the one exit where the
    // model loop is still mid-flight -- would drive the rest of that loop
    // after the user has gone, running real provider calls and real tool
    // calls nobody asked for, and bill for all of it. (The route to
    // `consumeStream()` changed with the v7 upgrade; on 6.0.141 `usage`
    // reached it through `finalStep` and `steps`. The hazard did not.)
    //
    // Each step announces what it spent in a `finish-step` part, so adding
    // those up as they arrive gives the same number with none of that.
    //
    // A stream that keeps producing, so the consumer is what stops the turn
    // rather than the stream running out.
    streamTextRetry.mockReturnValue({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "hello " };
        yield { type: "finish-step", usage: { totalTokens: 900 } };
        yield { type: "text-delta", text: "world" };
        // Never reached: the consumer walks away first.
        yield { type: "text-delta", text: " and more" };
      })(),
      get usage() {
        usageRead();
        return Promise.resolve({ totalTokens: 1200 });
      },
    });

    const { MainAgent } = await import("@server/agent/main-agent.js");
    const { runWithContext } = await import("@breatic/core");

    // Same wrapper the route uses: MainAgent reads its context out of
    // AsyncLocalStorage rather than taking it as an argument.
    await runWithContext(
      {
        userId: "u1",
        conversationId: "c1",
        projectId: "p1",
      },
      async () => {
        const agent = new MainAgent();
        const gen = agent.chat("hi");
        // Every turn opens by handing over the stored conversation, which is
        // not part of what this case is about -- so it is pulled and set
        // aside, and the two pulls below are the model's own output, far
        // enough in to have passed the step the billing figure comes from.
        const settleUp = await gen.next();
        expect(settleUp.value?.event).toBe(SSE_EVENT_NAMES.CHAT_TURN_STARTED);
        await gen.next();
        await gen.next();
        // The browser goes away.
        await gen.return(undefined);
      },
    );

    const saved = addMessage.mock.calls.map(([, msg]) => msg);
    expect(
      saved.some(
        (msg) =>
          msg.role === "assistant" &&
          (msg.parts as Array<{ type: string; text?: string }>).some(
            (part) => part.type === "text" && String(part.text).includes("hello"),
          ),
      ),
    ).toBe(true);
    expect(consolidateIfNeeded).toHaveBeenCalled();
    expect(deductOnce).toHaveBeenCalled();
    // What it billed for is the step the stream actually reported, not the
    // figure the consuming getter would have produced.
    expect(deductOnce.mock.calls[0]?.[4]).toMatchObject({ tokensUsed: 900 });
    expect(usageRead).not.toHaveBeenCalled();
  });
});
