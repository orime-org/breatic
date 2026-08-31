// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The ceiling on what one model call may write back (#148, G3).
 *
 * The budget bounds what goes to the model. Without a matching bound on what
 * comes back, one answer can run until the provider stops it, and every
 * later turn carries the whole of it in the history.
 *
 * The ceiling is per model call, which is the only unit the SDK offers:
 * `stopWhen: stepCountIs(...)` lets one turn make many, and each is bounded
 * by this.
 */

import { describe, it, expect, vi } from "vitest";
import type * as CoreModule from "@breatic/core";
import type * as DomainModule from "@breatic/domain";
import { finishedSpending } from "../helpers/model-double.js";

const streamTextRetry = vi.hoisted(() => vi.fn());
const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>) => 1);

vi.mock("@server/agent/turn-context.js", () => ({
  buildTurnContext: vi.fn(async () => ({
    memoryContext: { projectMemory: "", conversationMemory: "" },
    compressedHistory: [],
    watermark: 0,
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
  return {
    ...base,
    streamTextRetry,
    finalizeTurn: actual.finalizeTurn,
    buildAgentConfig: actual.buildAgentConfig,
    creditLotService: { chargeOnceForGeneration: vi.fn(async () => null) },
    resolveProvider: () => "test",
    getModel: () => ({ modelId: "test" }),
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
vi.mock("@server/agent/turn-budget.js", () => ({
  foldIfOverBudget: vi.fn(async () => false),
}));
vi.mock("@server/agent/context.js", () => ({ buildSystemPrompt: () => "system" }));

/**
 * A stream that says one word and stops.
 * @returns What `streamTextRetry` would have returned.
 */
function saysOk() {
  const parts = [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "ok" },
    { type: "text-end", id: "t1" },
    finishedSpending(10),
  ];
  return {
    toUIMessageStream: () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({ type: "text-delta", id: "t1", delta: "ok" });
          controller.enqueue({ type: "text-end", id: "t1" });
          controller.close();
        },
      }),
    fullStream: (async function* () {
      for (const part of parts) yield part;
    })(),
  };
}

describe("what one model call may write back", () => {
  it("is bounded, by the figure the config carries", async () => {
    streamTextRetry.mockReturnValue(saysOk());
    const { MainAgent } = await import("@server/agent/main-agent.js");
    const { runWithContext, getAgentConfig } = await import("@breatic/core");

    await runWithContext(
      { userId: "u1", conversationId: "c1", projectId: "p1" },
      async () => {
        for await (const _chunk of await new MainAgent().chat("hi")) {
          // drained
        }
      },
    );

    const sent = streamTextRetry.mock.calls[0]?.[0] as { maxOutputTokens?: number };
    expect(sent.maxOutputTokens).toBe(getAgentConfig().max_output_tokens);
  });
});
