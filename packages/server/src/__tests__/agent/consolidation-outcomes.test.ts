// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How one consolidation ends (#148, N4 N6 N7 N9 N10 T3).
 *
 * Consolidation moved in front of the reply, so its failures are now on the
 * path of a turn somebody is waiting for. There are only two results and no
 * middle: either the memory and the watermark both move, or neither memory is
 * written and the watermark moves anyway — the window is discarded and the
 * turn goes out regardless.
 *
 * Discarding rather than retrying next turn is what keeps a conversation from
 * wedging. The consolidation call is `temperature: 0` and a failure leaves
 * the watermark where it was, so the next turn would send a strictly larger
 * version of an input that already failed, deterministically, forever — three
 * model calls burnt each time, and no refresh or relogin changes any of it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as CoreModule from "@breatic/core";
import type { ModelMessage } from "ai";

const generateTextRetry = vi.fn();
const chargeOnceForGeneration = vi.fn(async (..._args: unknown[]) => null);
const commitConsolidation = vi.fn(async (..._args: unknown[]) => "written" as const);
const discardConsolidation = vi.fn(async (..._args: unknown[]) => undefined);

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
    generateTextRetry,
    getModel: () => ({ modelId: "test-model" }),
    resolveProvider: () => "test",
    creditLotService: { chargeOnceForGeneration },
  };
});

vi.mock("@server/modules", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    memoryService: {
      commitConsolidation,
      discardConsolidation,
      buildContext: vi.fn(async () => ({ projectMemory: "", conversationMemory: "" })),
    },
  };
});

vi.mock("@server/modules/memory/memory.repo.js", () => ({
  getConversationMemory: vi.fn(async () => "what was settled so far"),
  getProjectMemory: vi.fn(async () => "the project so far"),
}));

const { consolidateWindow } = await import("@server/agent/memory-consolidator.js");
const { logger } = await import("@breatic/core");

const USER = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";

const TRANSCRIPT: ModelMessage[] = [
  { role: "user", content: "read these three pages and tell me what they say" },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "web_fetch",
        output: { type: "text", value: "[earlier tool result omitted from context]" },
      },
    ],
  },
  { role: "assistant", content: "they all describe the same technique" },
];

/**
 * Ask for one consolidation, with everything the caller would have worked out.
 * @param over - Fields to change for this case.
 * @returns Whatever the consolidation ended as.
 */
async function consolidate(over: Record<string, unknown> = {}) {
  return consolidateWindow({
    userId: USER,
    conversationId: CONVERSATION,
    projectId: PROJECT,
    transcript: TRANSCRIPT,
    watermarkBefore: 7,
    newWatermark: 19,
    ...over,
  });
}

/** A model answer in the shape the consolidation prompt asks for. */
const GOOD_ANSWER = {
  text: JSON.stringify({
    conversationUpdate: "they settled on one technique",
    projectUpdate: "the project uses that technique",
    historyEntry: "read three pages",
  }),
  usage: { totalTokens: 400 },
};

beforeEach(() => {
  vi.clearAllMocks();
  generateTextRetry.mockResolvedValue(GOOD_ANSWER);
  commitConsolidation.mockResolvedValue("written");
});

describe("a consolidation that works", () => {
  it("writes both layers and moves the watermark in one call", async () => {
    const outcome = await consolidate();

    expect(outcome).toBe("written");
    expect(commitConsolidation).toHaveBeenCalledTimes(1);
    expect(commitConsolidation.mock.calls[0]?.[0]).toMatchObject({
      userId: USER,
      conversationId: CONVERSATION,
      projectId: PROJECT,
      newWatermark: 19,
      data: {
        conversationUpdate: "they settled on one technique",
        projectUpdate: "the project uses that technique",
      },
    });
    expect(discardConsolidation).not.toHaveBeenCalled();
  });

  it("reads the window it was handed, placeholders and all", async () => {
    // N10: the input is the assembled messages the budget was measured
    // against, not the stored rows. A consolidation reading storage would see
    // the whole of every tool result, which is the thing compression just
    // took out.
    await consolidate();

    const prompt = String(
      (generateTextRetry.mock.calls[0]?.[0] as { messages: { content: string }[] })
        .messages[0]?.content,
    );
    expect(prompt).toContain("[earlier tool result omitted from context]");
    expect(prompt).toContain("they all describe the same technique");
  });

  it("bounds what the consolidating model may write", async () => {
    // N9: conversation memory is rewritten whole by this call, so an
    // unbounded answer is an unbounded segment of every later prompt.
    await consolidate();

    const call = generateTextRetry.mock.calls[0]?.[0] as { maxOutputTokens?: number };
    expect(call.maxOutputTokens).toBeGreaterThan(0);
  });

  it("bills the studio once for the window it consumed", async () => {
    // T3: the key is the conversation and the watermark it started from, so
    // two tabs that computed the same window pay for it once.
    await consolidate();

    expect(chargeOnceForGeneration).toHaveBeenCalledTimes(1);
    expect(chargeOnceForGeneration.mock.calls[0]?.[0]).toBe(
      `consolidate:${CONVERSATION}:7`,
    );
    expect(chargeOnceForGeneration.mock.calls[0]?.[1]).toMatchObject({
      projectId: PROJECT,
      actorUserId: USER,
    });
  });

  it("leaves the retrying to the call that already retries", async () => {
    // `generateTextRetry` is handed `llm_max_retries`, so one original and
    // two retries happen inside it. A loop here would make it nine.
    await consolidate();

    expect(generateTextRetry).toHaveBeenCalledTimes(1);
  });
});

describe("a consolidation that fails", () => {
  it("discards the window when the model call never succeeds", async () => {
    generateTextRetry.mockRejectedValue(new Error("502 upstream"));

    const outcome = await consolidate();

    expect(outcome).toBe("discarded");
    expect(commitConsolidation).not.toHaveBeenCalled();
    expect(discardConsolidation).toHaveBeenCalledWith(CONVERSATION, 19);
    expect(logger.error).toHaveBeenCalled();
    expect(chargeOnceForGeneration).not.toHaveBeenCalled();
  });

  it("discards the window when the answer is not the JSON it asked for", async () => {
    generateTextRetry.mockResolvedValue({ text: "Sure! Here is a summary.", usage: {} });

    const outcome = await consolidate();

    expect(outcome).toBe("discarded");
    expect(commitConsolidation).not.toHaveBeenCalled();
    expect(discardConsolidation).toHaveBeenCalledWith(CONVERSATION, 19);
    expect(logger.error).toHaveBeenCalled();
  });

  it("discards the window when the write fails", async () => {
    commitConsolidation.mockRejectedValue(new Error("deadlock detected"));

    const outcome = await consolidate();

    expect(outcome).toBe("discarded");
    expect(discardConsolidation).toHaveBeenCalledWith(CONVERSATION, 19);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe("a consolidation the reader did not wait for", () => {
  it("does nothing at all once the signal is raised", async () => {
    // N7: the reader pressed stop or the page went. This is a model call of
    // its own with a bill attached, and nobody is there to read what it
    // produces.
    const controller = new AbortController();
    controller.abort();

    const outcome = await consolidate({ signal: controller.signal });

    expect(outcome).toBe("aborted");
    expect(generateTextRetry).not.toHaveBeenCalled();
    expect(chargeOnceForGeneration).not.toHaveBeenCalled();
    expect(commitConsolidation).not.toHaveBeenCalled();
    expect(discardConsolidation).not.toHaveBeenCalled();
  });

  it("hands the signal to the model call so a stop mid-flight lands", async () => {
    const controller = new AbortController();

    await consolidate({ signal: controller.signal });

    const call = generateTextRetry.mock.calls[0]?.[0] as { abortSignal?: AbortSignal };
    expect(call.abortSignal).toBe(controller.signal);
  });
});

describe("two tabs that consolidated the same conversation", () => {
  it("keeps the memory that covers the further watermark", async () => {
    // N8: the transaction refuses to move the watermark backwards, so the
    // narrower window's write never lands. Its caller reassembles.
    commitConsolidation.mockResolvedValue("superseded");

    const outcome = await consolidate();

    expect(outcome).toBe("superseded");
    expect(discardConsolidation).not.toHaveBeenCalled();
  });

  it("still bills, and the key is what stops the second charge", async () => {
    commitConsolidation.mockResolvedValue("superseded");

    await consolidate();

    expect(chargeOnceForGeneration).toHaveBeenCalledTimes(1);
    expect(chargeOnceForGeneration.mock.calls[0]?.[0]).toBe(
      `consolidate:${CONVERSATION}:7`,
    );
  });
});
