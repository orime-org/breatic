// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The product guide names controls in the reader's language, inside a turn.
 *
 * The request pins the reader's locale for everything it runs; the guide reads
 * it when the SDK calls the tool, several awaits and a stream later. A lost
 * locale would not throw -- the guide would quietly name every button in
 * English while the reader's screen shows another language.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import type * as CoreModule from "@breatic/core";
import { FINISHED, FINISHED_ASKING_FOR_A_TOOL } from "../helpers/model-double.js";

/** What the model was sent on each call, as text. */
const prompts = vi.hoisted(() => ({ seen: [] as string[] }));

vi.mock("@server/agent/turn-context.js", () => ({
  buildTurnContext: vi.fn(async () => ({
    memoryContext: { projectMemory: "", conversationMemory: "" },
    compressedHistory: [],
  })),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  const base = await coreMock(importOriginal);
  const actual = await importOriginal<typeof CoreModule>();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    ...base,
    runWithContext: actual.runWithContext,
    getContext: actual.getContext,
    runWithLocale: actual.runWithLocale,
    loadLocales: actual.loadLocales,
    logger: { ...logger, child: () => logger },
  };
});

vi.mock("@breatic/domain", async (importOriginal) => {
  const { domainMock } = await import("../helpers/mock-core.js");
  const base = await domainMock();
  const actual = await importOriginal<Record<string, unknown>>();
  const { MockLanguageModelV4 } = await import("ai/test");
  // The real tool, so what is asserted is what production answers.
  const { productGuide } = await import("../../../../domain/src/agent/tools/product-guide.js");

  const firstCall = [
    { type: "tool-call", toolCallId: "g1", toolName: "get_product_guide", input: "{}" },
    FINISHED_ASKING_FOR_A_TOOL,
  ];

  return {
    ...base,
    streamTextRetry: actual.streamTextRetry,
    buildAgentConfig: () => ({
      modelId: "test",
      instructions: "system",
      tools: { get_product_guide: productGuide },
    }),
    finalizeTurn: async () => [],
    getModel: () =>
      new MockLanguageModelV4({
        doStream: async (options: { prompt: unknown }) => {
          prompts.seen.push(JSON.stringify(options.prompt));
          const script = prompts.seen.length === 1 ? firstCall : [FINISHED];
          return {
            stream: new ReadableStream({
              start(controller) {
                for (const part of script) controller.enqueue(part as never);
                controller.close();
              },
            }),
          };
        },
      }),
  };
});

vi.mock("@server/modules/conversation/conversation-message.repo.js", () => ({
  addMessage: vi.fn(async () => 1),
  getMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
}));

vi.mock("@server/modules/conversation/conversation.service.js", () => ({
  titleForTurn: vi.fn(async () => null),
}));

vi.mock("@server/agent/turn-budget.js", () => ({ foldIfOverBudget: vi.fn(async () => false) }));
vi.mock("@server/agent/context.js", () => ({ buildSystemPrompt: () => "system" }));

const { MainAgent } = await import("@server/agent/main-agent.js");
const { runWithContext, runWithLocale, loadLocales } = await import("@breatic/core");
const { t } = await import("@breatic/shared");

beforeAll(() => {
  loadLocales();
});

describe("the guide inside a chat turn", () => {
  it("names the controls in the language the request asked for", async () => {
    prompts.seen = [];
    await runWithLocale("zh-CN", () =>
      runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
        const turn = await new MainAgent().chat("怎么点生成？");
        for await (const _ of turn) {
          // Drained so the second model call, which reads the tool's answer, runs.
        }
      }),
    );

    const shown = runWithLocale("zh-CN", () => t("canvas.nodeMenu.generate"));
    expect(shown).not.toBe("Generate");
    const answer = prompts.seen[1] ?? "";
    expect(answer).toContain(`\\"${shown}\\"`);
  });
});
