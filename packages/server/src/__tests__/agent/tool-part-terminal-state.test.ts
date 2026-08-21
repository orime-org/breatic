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
 * itself failing.
 *
 * The model is the double here, and the tools are real: what these cases are
 * about is the state the SDK ends up reporting for a call, so a double for the
 * call itself would be this file deciding the answer it then checks.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import type * as CoreModule from "@breatic/core";
import { FINISHED_ASKING_FOR_A_TOOL } from "../helpers/model-double.js";
import type { ModelStreamPart } from "../helpers/model-double.js";
import type { MessagePart } from "@breatic/shared";

const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>) => 1);
const consolidateIfNeeded = vi.fn(async () => undefined);

/** What the model produces, and how the tool behaves, for this case. */
const thisCase = vi.hoisted(() => ({
  parts: [] as unknown[],
  /** Raised from inside the tool, standing in for the user pressing stop. */
  stopper: undefined as AbortController | undefined,
  /** What the tool does when called. */
  toolDoes: "answers",
}));

vi.mock("@server/agent/turn-context.js", () => ({
  buildTurnContext: vi.fn(async () => ({
    memoryContext: { userMemory: "", projectMemory: "", conversationMemory: "" },
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
  return {
    ...base,
    streamTextRetry: actual.streamTextRetry,
    buildAgentConfig: () => ({
      modelId: "test",
      instructions: "system",
      tools: {
        web_fetch: tool({
          description: "取一个网页",
          inputSchema: z.object({ url: z.string() }),
          execute: async (_input: { url: string }, { abortSignal }) => {
            if (thisCase.toolDoes === "throws") {
              throw new Error("the site refused the connection");
            }
            if (thisCase.toolDoes === "stops the turn") {
              thisCase.stopper?.abort();
              // Left waiting on the stop rather than returning: a call the
              // user stopped is one that never came back, which is the whole
              // situation being recorded here. The already-raised case is
              // checked first because the stop above is synchronous -- a
              // listener added after the fact waits for an event that has
              // been and gone.
              await new Promise<void>((resolve) => {
                if (abortSignal === undefined || abortSignal.aborted) {
                  resolve();
                  return;
                }
                abortSignal.addEventListener("abort", () => {
                  resolve();
                });
              });
            }
            return "两条链接";
          },
        }),
      },
    }),
    finalizeTurn: async (opts: { steps: { persist?: () => Promise<void> } }) => {
      await opts.steps.persist?.();
      return [];
    },
    getModel: () => modelProducing(() => thisCase.parts as ModelStreamPart[]),
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

vi.mock("@server/modules/conversation/conversation-message.repo.js", () => ({
  addMessage,
  getMessages,
}));
// The turn asks the conversation what it is called, so it can say so in the
// event that opens the turn. Answered with a name already set: these tests are
// about what a turn streams, not about how a conversation comes by its name.
vi.mock("@server/modules/conversation/conversation.service.js", () => ({
  titleForTurn: vi.fn(async () => "already named"),
}));

vi.mock("@server/agent/memory-consolidator.js", () => ({ consolidateIfNeeded }));
vi.mock("@server/agent/context.js", () => ({ buildSystemPrompt: () => "system" }));

const { MainAgent } = await import("@server/agent/main-agent.js");
const { runWithContext } = await import("@breatic/core");


/** The model asking for the one tool this file registers. */
const asksForTheTool: ModelStreamPart = {
  type: "tool-call",
  toolCallId: "tc-1",
  toolName: "web_fetch",
  input: JSON.stringify({ url: "https://example.com" }),
};

/**
 * Run one turn and read back what was stored.
 * @param toolDoes - How the tool behaves this time.
 * @returns The parts of the stored assistant message, or an empty list.
 */
async function storedPartsWhenTool(
  toolDoes: "answers" | "throws" | "stops the turn",
): Promise<MessagePart[]> {
  thisCase.toolDoes = toolDoes;
  thisCase.parts = [asksForTheTool, FINISHED_ASKING_FOR_A_TOOL];
  const stopper = new AbortController();
  thisCase.stopper = stopper;

  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    const turn = await new MainAgent().chat("do something", stopper.signal);
    for await (const _chunk of turn) {
      // drained
    }
  });

  const reply = addMessage.mock.calls.map(([, msg]) => msg).find((m) => m.role === "assistant");
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
    addMessage.mockClear();
  });

  it("records a tool the SDK reported as failed", async () => {
    const parts = await storedPartsWhenTool("throws");

    const failed = toolPart(parts);
    expect(failed?.status).toBe("error");
    expect(failed?.failure?.kind).toBe("tool_failed");
    expect(failed?.failure?.forModel).toContain("refused");
  });

  it("does not leave a tool the user stopped mid-flight looking like it is still running", async () => {
    // The SDK delivers no result for a call in flight when the turn is
    // stopped, so nothing else will ever close this part out.
    const parts = await storedPartsWhenTool("stops the turn");

    const stopped = toolPart(parts);
    expect(stopped).toBeDefined();
    expect(stopped?.status).not.toBe("pending");
    // And it says which of the two endings it was, so neither the panel nor
    // the next turn has to guess. This used to be told from whether a reason
    // came with it, which made every failure look like the user's doing the
    // moment a reason went missing.
    expect(stopped?.failure?.kind).toBe("user_aborted");
    // And the turn itself is marked, or coming back to the conversation shows
    // an answer that simply stopped short with nothing to say why.
    expect(parts.some((p) => p.type === "interrupted")).toBe(true);
  });

  it("still records a normal tool use as successful", async () => {
    const parts = await storedPartsWhenTool("answers");

    expect(toolPart(parts)?.status).toBe("success");
    expect(toolPart(parts)?.output).toBe("两条链接");
  });
});
