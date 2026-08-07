// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * A turn's obligations survive the user closing the page.
 *
 * This is the defect the turn-finalizer exists for. The cleanup used to sit
 * after the streaming loop, and SSE is an async generator: when the browser
 * goes away the consumer calls `.return()` on it, the generator stops where
 * it was suspended, and every line after the loop is skipped. The reply was
 * never saved, memory never consolidated, the turn never billed.
 *
 * MainAgent had no tests at all before this one, which is how the defect
 * survived. It was found by running the product, not by running the suite --
 * every test was green the whole time.
 *
 * `gen.return()` is exactly what the SSE consumer does on disconnect, so
 * this reproduces the real failure rather than a stand-in for it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const addMessage = vi.fn(
  async (_id: string, _msg: Record<string, unknown>) => 1,
);
const consolidateIfNeeded = vi.fn(async () => undefined);
const deductOnce = vi.fn(async () => undefined);

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
  const actual = await importOriginal<typeof import("@breatic/core")>();
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
  const actual = await vi.importActual<typeof import("@breatic/domain")>(
    "@breatic/domain",
  );
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
vi.mock("@server/modules/conversation/conversation.repo.js", () => ({
  addMessage,
}));

vi.mock("@server/agent/memory-consolidator.js", () => ({
  consolidateIfNeeded,
}));

// What the prompt says is not what this test is about.
vi.mock("@server/agent/context.js", () => ({
  buildSystemPrompt: () => "system",
}));

beforeEach(() => {
  addMessage.mockClear();
  consolidateIfNeeded.mockClear();
  deductOnce.mockClear();
});

describe("a turn cut short by the client", () => {
  it("still saves, consolidates and bills", async () => {
    // A stream that keeps producing, so the consumer is what stops the turn
    // rather than the stream running out.
    streamTextRetry.mockReturnValue({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "hello " };
        yield { type: "text-delta", text: "world" };
        // Never reached: the consumer walks away first.
        yield { type: "text-delta", text: " and more" };
      })(),
      usage: Promise.resolve({ totalTokens: 1200 }),
    });

    const { MainAgent } = await import("@server/agent/main-agent.js");
    const { runWithContext } = await import("@breatic/core");

    // Same wrapper the route uses: MainAgent reads its context out of
    // AsyncLocalStorage rather than taking it as an argument.
    await runWithContext(
      {
        userId: "u1",
        conversationId: "c1",
        memoryContext: {
          userMemory: "",
          projectMemory: "",
          conversationMemory: "",
        },
        compressedHistory: [],
      },
      async () => {
        const agent = new MainAgent();
        const gen = agent.chat("hi");
        await gen.next();
        await gen.next();
        // The browser goes away.
        await gen.return(undefined);
      },
    );

    const saved = addMessage.mock.calls.map(([, msg]) => msg);
    expect(
      saved.some(
        (msg) => msg.role === "assistant" && String(msg.content).includes("hello"),
      ),
    ).toBe(true);
    expect(consolidateIfNeeded).toHaveBeenCalled();
    expect(deductOnce).toHaveBeenCalled();
  });
});
