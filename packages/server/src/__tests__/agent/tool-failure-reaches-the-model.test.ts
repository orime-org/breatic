// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A tool that failed is in front of the model on its very next step.
 *
 * This is the whole point of the tools throwing rather than answering, and it
 * is the one thing the pieces either side cannot show on their own: the tool
 * test proves the throw carries a reason, the storage test proves the reason
 * is written down, and neither says whether the model ever sees it.
 *
 * The model is the double; the tool is a stand-in that fails the way ours do,
 * because what it says is checked where the real ones live. What is asserted
 * is the prompt the SDK assembled, not one this file wrote.
 *
 * Only the model's half is checked here. Whether the reader's half stays out
 * of the prompt is not this file's to prove: within one turn the SDK reads
 * nothing but the error's message, so an assertion here would hold no matter
 * what the code did. It is checked where it can fail — the conversion that
 * replays a stored turn, in model-messages.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import type * as CoreModule from "@breatic/core";
import { FINISHED_ASKING_FOR_A_TOOL, saying } from "../helpers/model-double.js";
import type { ModelStreamPart } from "../helpers/model-double.js";

const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>) => 1);

/** Every prompt the model was handed this turn, in order. */
const promptsSeen: unknown[] = [];

/** What the tool does, and how many steps the model has taken. */
const thisCase = vi.hoisted(() => ({ step: 0 }));

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
  return { ...base, runWithContext: actual.runWithContext, getContext: actual.getContext };
});

vi.mock("@breatic/domain", async (importOriginal) => {
  const { domainMock } = await import("../helpers/mock-core.js");
  const base = await domainMock();
  const actual = await importOriginal<Record<string, unknown>>();
  const { modelProducing } = await import("../helpers/model-double.js");
  const { carrying } = await import("@breatic/shared");
  return {
    ...base,
    streamTextRetry: actual.streamTextRetry,
    buildAgentConfig: () => ({
      modelId: "test",
      instructions: "system",
      tools: {
        // A tool that fails the way ours do: it throws, and the error carries
        // both halves of the reason. What it says is the real tools' business
        // and is checked where they live; what matters here is where each
        // half ends up.
        web_search: tool({
          description: "fetch a page",
          inputSchema: z.object({ url: z.string() }),
          execute: async (): Promise<string> => {
            throw carrying(new Error(FOR_MODEL), {
              kind: "tool_failed",
              forModel: FOR_MODEL,
              readerKey: FOR_READER,
            });
          },
        }),
      },
    }),
    finalizeTurn: async (opts: { steps: { persist?: () => Promise<void> } }) => {
      await opts.steps.persist?.();
      return [];
    },
    getModel: () =>
      modelProducing(
        () => {
          thisCase.step += 1;
          // Ask for the tool once, then speak. What it says does not matter:
          // this is about what it was handed, not what it does with it.
          return thisCase.step === 1
            ? [asksForTheTool, FINISHED_ASKING_FOR_A_TOOL]
            : saying("could not read that page");
        },
        ({ prompt }) => promptsSeen.push(prompt),
      ),
  };
});

const getMessages = vi.fn(async () => ({ messages: [], hasMore: false }));

vi.mock("@server/modules/conversation/conversation-message.repo.js", () => ({
  addMessage,
  getMessages,
}));
vi.mock("@server/modules/conversation/conversation.service.js", () => ({
  titleForTurn: vi.fn(async () => "already named"),
}));
vi.mock("@server/agent/turn-budget.js", () => ({
  foldIfOverBudget: vi.fn(async () => false),
}));
vi.mock("@server/agent/context.js", () => ({ buildSystemPrompt: () => "system" }));

const { MainAgent } = await import("@server/agent/main-agent.js");
const { runWithContext } = await import("@breatic/core");

/** The address the stubbed tool in this file is asked for, and fails on. */
const REFUSED = "https://public.example/page";

/** The model asking for the one tool this file registers. */
const asksForTheTool: ModelStreamPart = {
  type: "tool-call",
  toolCallId: "tc-1",
  toolName: "web_search",
  input: JSON.stringify({ url: REFUSED }),
};

/** The specific reason, of the kind only the model is given. */
const FOR_MODEL =
  `Fetching ${REFUSED} failed: the site answered HTTP 404. Do not fetch the same address again.`;

/** The coarse line a reader is shown, which the model has no use for. */
const FOR_READER = "chat.tool.failure.upstream";

describe("what the model is handed after a tool fails", () => {
  beforeEach(() => {
    thisCase.step = 0;
    promptsSeen.length = 0;
    addMessage.mockClear();
  });

  it("puts the reason in front of it on the next step of the same turn", async () => {
    await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
      const turn = await new MainAgent().chat("read that page", new AbortController().signal);
      for await (const _chunk of turn) {
        // drained
      }
    });

    expect(promptsSeen.length).toBeGreaterThanOrEqual(2);
    const second = JSON.stringify(promptsSeen[1]);

    // The SDK's own way of saying "this call failed", rather than a result
    // that happens to read like a complaint.
    expect(second).toContain("error-text");
    expect(second).toContain("404");
    expect(second).toContain(REFUSED);
  });

});
