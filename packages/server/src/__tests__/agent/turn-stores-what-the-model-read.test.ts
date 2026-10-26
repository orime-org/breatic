// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A turn writes down what the model was given for every tool call that
 * answered, and writing it down cannot cost the turn its record or its bill.
 *
 * The model is the double here and the tools are real, so the value checked
 * is the one the turn's own tool set produced -- the set the model ran with,
 * which only `askTheModel` sees.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import type * as CoreModule from "@breatic/core";
import type { MessagePart } from "@breatic/shared";
import { FINISHED_ASKING_FOR_A_TOOL, saying } from "../helpers/model-double.js";
import type { ModelStreamPart } from "../helpers/model-double.js";

const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>) => 1);
const foldIfTooLong = vi.fn(async () => "none");

const thisCase = vi.hoisted(() => ({
  parts: [] as unknown[],
  laterParts: undefined as unknown[] | undefined,
  modelCalls: 0,
  stopper: undefined as AbortController | undefined,
  /** The steps `finalizeTurn` ran, in order. */
  ranSteps: [] as string[],
}));

const renders = vi.hoisted(() => ({
  /** Renders its answer for the model. */
  listed: ({ output }: { output: unknown }) => ({
    type: "text" as const,
    value: `listed: ${(output as { names: string[] }).names.join(", ")}`,
  }),
}));

vi.mock("@server/agent/turn-context.js", () => ({
  buildTurnContext: vi.fn(async () => ({
    memoryContext: { projectMemory: "", conversationMemory: "" },
    history: [],
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
      instructions: { base: "system" },
      tools: {
        list_things: tool({
          description: "lists things",
          inputSchema: z.object({ q: z.string() }),
          execute: async () => ({ names: ["a", "b"] }),
          toModelOutput: renders.listed,
        }),
        // Answers after the turn is stopped under it, so the SDK never gets to
        // convert the answer and the first conversion is the one the turn
        // makes when it writes the call down -- the call that converts badly.
        breaks_on_render: tool({
          description: "answers late and renders badly",
          inputSchema: z.object({ q: z.string() }),
          execute: async (_input, { abortSignal }) => {
            thisCase.stopper?.abort();
            await new Promise<void>((resolve) => {
              if (abortSignal === undefined || abortSignal.aborted) {
                resolve();
                return;
              }
              abortSignal.addEventListener("abort", () => {
                resolve();
              });
            });
            return { names: [] };
          },
          toModelOutput: () => {
            throw new TypeError("Cannot read properties of undefined (reading 'length')");
          },
        }),
      },
    }),
    finalizeTurn: async (opts: { steps: Record<string, (() => Promise<void>) | undefined> }) => {
      for (const name of ["persist", "bill"]) {
        await opts.steps[name]?.();
        thisCase.ranSteps.push(name);
      }
      return [];
    },
    getModel: () =>
      modelProducing(() => {
        thisCase.modelCalls += 1;
        const later = thisCase.laterParts as ModelStreamPart[] | undefined;
        if (thisCase.modelCalls > 1 && later !== undefined) return later;
        return thisCase.parts as ModelStreamPart[];
      }),
  };
});

const getMessages = vi.fn(async () => ({ messages: [], hasMore: false }));
vi.mock("@server/modules/conversation/conversation-message.repo.js", () => ({
  addMessage,
  addReaderMessage: async (id: string, msg: Record<string, unknown>) => ({ turnIndex: await addMessage(id, msg), closedAsks: [] }),
  getMessages,
}));
vi.mock("@server/modules/conversation/conversation.service.js", () => ({
  titleForTurn: vi.fn(async () => "already named"),
}));
vi.mock("@server/agent/turn-fold.js", () => ({ foldIfTooLong }));
vi.mock("@server/agent/context.js", () => ({ buildSystemPrompt: () => "system" }));

const { MainAgent } = await import("@server/agent/main-agent.js");
const { runWithContext } = await import("@breatic/core");
const { mocks } = await import("../helpers/mock-core.js");
const { EARLIER_RESULT_NOTE } = await import("@server/agent/stored-model-output.js");

/**
 * Run one turn in which the model calls one tool.
 * @param toolName - The tool the model calls.
 * @returns The tool part of the stored reply.
 */
async function storedCallOf(toolName: string): Promise<Extract<MessagePart, { type: "tool" }>> {
  thisCase.parts = [
    { type: "tool-call", toolCallId: "tc-1", toolName, input: JSON.stringify({ q: "x" }) },
    FINISHED_ASKING_FOR_A_TOOL,
  ];
  thisCase.laterParts = saying("done");
  const stopper = new AbortController();
  thisCase.stopper = stopper;

  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    const turn = await new MainAgent().chat("go", stopper.signal);
    for await (const _chunk of turn) {
      // drained
    }
  });

  const reply = addMessage.mock.calls.map(([, msg]) => msg).find((m) => m.role === "assistant");
  const part = ((reply?.parts as MessagePart[] | undefined) ?? []).find((p) => p.type === "tool");
  if (part?.type !== "tool") throw new Error("the turn stored no tool part");
  return part;
}

beforeEach(() => {
  addMessage.mockClear();
  mocks.logger.error.mockClear();
  thisCase.modelCalls = 0;
  thisCase.ranSteps = [];
  thisCase.stopper = undefined;
});

describe("what a turn writes down for the model", () => {
  it("stores the tool's own conversion of what it answered", async () => {
    const part = await storedCallOf("list_things");

    expect(part.status).toBe("success");
    expect(part.forModel).toEqual(renders.listed({ output: { names: ["a", "b"] } }));
  });

  it("still stores the reply and bills the turn when the conversion fails", async () => {
    const part = await storedCallOf("breaks_on_render");

    expect(part.status).toBe("success");
    expect(part.forModel).toEqual({ type: "text", value: EARLIER_RESULT_NOTE });
    expect(thisCase.ranSteps).toEqual(["persist", "bill"]);
    expect(
      mocks.logger.error.mock.calls.some(
        ([ctx]) => (ctx as { toolName?: string }).toolName === "breaks_on_render",
      ),
    ).toBe(true);
  });
});
