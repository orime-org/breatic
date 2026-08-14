// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * A stored tool part always says how that use of the tool ended.
 *
 * `pending` means "still running", and a stored message is not running — it is
 * a record of something that already happened. A part left pending is a record
 * that lies, and the panel renders it as a spinner that never stops.
 *
 * Two things end a call without a result: the user stopping the turn while the
 * tool is in flight (the SDK then delivers no result for it), and the tool
 * itself failing. Neither was recorded before.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as CoreModule from "@breatic/core";
import type { MessagePart } from "@breatic/shared";

const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>) => 1);
const consolidateIfNeeded = vi.fn(async () => undefined);
const streamTextRetry = vi.fn();

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
  return { ...base, runWithContext: actual.runWithContext, getContext: actual.getContext };
});

vi.mock("@breatic/domain", async () => {
  const { domainMock } = await import("../helpers/mock-core.js");
  const base = await domainMock();
  return {
    ...base,
    buildAgentConfig: () => ({ modelId: "test", instructions: "system", tools: {} }),
    finalizeTurn: async (opts: { steps: { persist?: () => Promise<void> } }) => {
      await opts.steps.persist?.();
      return [];
    },
    streamTextRetry,
    getModel: () => ({ modelId: "test" }),
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

const { MainAgent } = await import("@server/agent/main-agent.js");
const { runWithContext } = await import("@breatic/core");

/**
 * Run one turn over the given stream and read back what was stored.
 * @param parts - The parts the model's stream produces
 * @returns The parts of the stored assistant message, or an empty list
 */
async function storedPartsFrom(parts: unknown[]): Promise<MessagePart[]> {
  streamTextRetry.mockReturnValue({
    fullStream: (async function* () {
      for (const part of parts) yield part;
    })(),
    text: Promise.resolve(""),
    totalUsage: Promise.resolve({ totalTokens: 0 }),
  });

  await runWithContext(
    {
      userId: "u1",
      conversationId: "c1",
      projectId: "p1",
    },
    async () => {
      for await (const _ of new MainAgent().chat("do something")) {
        // drained
      }
    },
  );

  const reply = addMessage.mock.calls
    .map(([, msg]) => msg)
    .find((m) => m.role === "assistant");
  return (reply?.parts as MessagePart[]) ?? [];
}

/**
 * The tool part of a stored message, narrowed.
 * @param parts - The stored parts
 * @returns The first tool part, or undefined
 */
function toolPart(parts: MessagePart[]): Extract<MessagePart, { type: "tool" }> | undefined {
  return parts.find((p): p is Extract<MessagePart, { type: "tool" }> => p.type === "tool");
}

describe("how a tool use is recorded when it does not come back", () => {
  beforeEach(() => {
    streamTextRetry.mockClear();
    addMessage.mockClear();
  });

  it("records a tool the SDK reported as failed", async () => {
    const parts = await storedPartsFrom([
      { type: "tool-call", toolCallId: "tc-1", toolName: "web_fetch", input: { url: "x" } },
      { type: "tool-error", toolCallId: "tc-1", error: new Error("the site refused the connection") },
      { type: "finish-step", usage: { totalTokens: 50 } },
    ]);

    const tool = toolPart(parts);
    expect(tool?.status).toBe("error");
    expect(tool?.errorMessage).toContain("refused");
  });

  it("does not leave a tool the user stopped mid-flight looking like it is still running", async () => {
    // The SDK delivers no result for a call in flight when the turn is
    // stopped, so nothing else will ever close this part out.
    const parts = await storedPartsFrom([
      { type: "tool-call", toolCallId: "tc-2", toolName: "web_search", input: { query: "x" } },
      { type: "abort" },
    ]);

    const tool = toolPart(parts);
    expect(tool).toBeDefined();
    expect(tool?.status).not.toBe("pending");
  });

  it("still records a normal tool use as successful", async () => {
    const parts = await storedPartsFrom([
      { type: "tool-call", toolCallId: "tc-3", toolName: "web_search", input: { query: "x" } },
      { type: "tool-result", toolCallId: "tc-3", output: "two links" },
      { type: "text-delta", text: "Here." },
      { type: "finish-step", usage: { totalTokens: 50 } },
    ]);

    expect(toolPart(parts)?.status).toBe("success");
  });
});
