// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * How one consolidation ends (#148, #1363, #1336, #961).
 *
 * Consolidation sits in front of the reply, so its failures are on the path
 * of a turn somebody is waiting for. A fold writes its answer -- entry
 * operations and a progress note -- with the watermark, or writes nothing and
 * leaves the watermark where it was, so the next fold reads the same turns
 * again. An answer that fails its checks is asked for again with the errors,
 * up to `consolidation_answer_attempts` times; every attempt is a model call
 * and is charged under its own key.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as CoreModule from "@breatic/core";
import type * as DomainModule from "@breatic/domain";
import type { ModelMessage } from "ai";

const generateTextRetry = vi.fn();
const chargeOnce = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
const commitConsolidation = vi.fn<(...args: unknown[]) => Promise<"written" | "superseded">>();

const SHOWN = "44444444-4444-4444-8444-444444444444";
const TITLE_ONLY = "55555555-5555-4555-8555-555555555555";

// What the fold is shown of the memory it is changing.
const consolidationInput = vi.fn(async () => ({
  full: [
    {
      id: SHOWN,
      scope: "project" as const,
      title: "Palette",
      content: "Teal and orange, remember exactly: {messages} $&",
      origin: "agent" as const,
      sourceConversationId: null,
      updatedAt: "2026-11-01T00:00:00.000Z",
    },
  ],
  titlesOnly: [{ id: TITLE_ONLY, title: "Old lens note", scope: "project" as const }],
  progress: "what was settled so far",
}));

// Set apart from what `config/agent.yaml` ships and from what `mock-core`
// answers, so an implementation that writes a number in cannot pass.
const OUTPUT_CEILING = 4242;
const ATTEMPTS = 3;
const CONSOLIDATION_MODEL = "deepseek/deepseek-v4.1-flash-1017";

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  const base = await coreMock(importOriginal);
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...base,
    runWithContext: actual.runWithContext,
    getContext: actual.getContext,
    getAgentConfig: () => ({
      ...(base.getAgentConfig as () => Record<string, unknown>)(),
      max_output_tokens: OUTPUT_CEILING,
      consolidation_answer_attempts: ATTEMPTS,
      consolidation_max_operations: 50,
      memory_progress_max_chars: 2000,
      consolidation_entries_max_chars: 60000,
      consolidation_model: CONSOLIDATION_MODEL,
      default_model: "anthropic/claude-opus-5.5",
    }),
  };
});

const getModel = vi.fn((id: string) => ({ modelId: id }));

vi.mock("@breatic/domain", async (importOriginal) => {
  const { domainMock } = await import("../helpers/mock-core.js");
  const base = await domainMock();
  const actual = await importOriginal<typeof DomainModule>();
  return {
    ...base,
    generateTextRetry,
    getModel,
    resolveProvider: () => "test",
    // The real one. What it puts on the call is the thing being asserted,
    // and a stub would be answering the question with its own return value.
    callOptionsFor: actual.callOptionsFor,
    memoryTitle: actual.memoryTitle,
    countCharacters: actual.countCharacters,
    memoryContent: actual.memoryContent,
    creditLotService: { chargeOnce },
  };
});

vi.mock("@server/modules", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    memoryService: { commitConsolidation, consolidationInput },
  };
});

const { consolidateWindow } = await import("@server/agent/memory-consolidator.js");
const { logger } = await import("@breatic/core");
const { createUsageRecorder } = await import("@breatic/domain");

/** The part of a charge key that tells one fold from another. */
const FOLD_ID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const USER = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";

/**
 * The window as the caller hands it over, converted, turn by turn.
 * @returns The window, in the shape `foldIfTooLong` builds it.
 */
async function handedWindow(): Promise<Array<{ turnIndex: number; messages: ModelMessage[] }>> {
  const { toModelMessages } = await import("@server/agent/model-messages.js");
  const history = [1, 2, 3, 4].flatMap((n) => [
    {
      role: "user" as const,
      content: `read page ${n}`,
      parts: [{ type: "text" as const, text: `read page ${n}` }],
      ts: "",
      turnIndex: n,
    },
    {
      role: "assistant" as const,
      content: "they all describe the same technique",
      parts: [
        {
          type: "tool" as const,
          toolCallId: `c${n}`,
          toolName: "web_search",
          input: { url: `https://example.test/${n}` },
          status: "success" as const,
          output: `the whole of page ${n}`,
        },
        { type: "text" as const, text: "they all describe the same technique" },
      ],
      ts: "",
      turnIndex: n,
    },
  ]);
  return [1, 2, 3, 4].map((n) => ({ turnIndex: n, messages: toModelMessages(history.filter((row) => row.turnIndex === n)) }));
}

const TURNS = await handedWindow();

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
    turns: TURNS,
    watermarkBefore: 7,
    newWatermark: 19,
    ...over,
  });
}

/** The usage every answer in this suite reports; the recorder double settles it to 400. */
const USAGE = {
  inputTokens: 150,
  inputTokenDetails: { noCacheTokens: 150, cacheReadTokens: 0 },
  outputTokens: 250,
  outputTokenDetails: { reasoningTokens: 0 },
  totalTokens: 400,
};

/**
 * A model reply carrying this text.
 * @param text - What the model wrote.
 * @param finishReason - Why it stopped.
 * @returns The reply in the SDK's shape.
 */
function reply(text: string, finishReason = "stop") {
  return { text, finishReason, usage: USAGE, providerMetadata: undefined, response: { id: "gen-5" } };
}

/** An answer in the shape the consolidation prompt asks for. */
const GOOD = {
  progress: "they settled on one technique",
  operations: [
    { op: "add", scope: "project", title: "Technique: dry brush", content: "Every page uses dry brush." },
    { op: "update", id: SHOWN, title: "Palette", content: "Teal and orange." },
  ],
};
const GOOD_ANSWER = reply(JSON.stringify(GOOD));

/**
 * What the n-th model call was sent.
 * @param n - Which call, from 0.
 * @returns Its messages.
 */
function sentTo(n: number): Array<{ role: string; content: string }> {
  return (generateTextRetry.mock.calls[n]?.[0] as { messages: Array<{ role: string; content: string }> }).messages;
}

/**
 * The prompt the first call was sent.
 * @returns Its text.
 */
function prompt(): string {
  return String(sentTo(0)[0]?.content);
}

beforeEach(() => {
  vi.clearAllMocks();
  generateTextRetry.mockResolvedValue(GOOD_ANSWER);
  commitConsolidation.mockResolvedValue("written");
  // `clearAllMocks` forgets calls, not implementations: a case that made one
  // of these reject would otherwise leave it rejecting for every case after.
  chargeOnce.mockResolvedValue(null);
});

describe("a consolidation that works", () => {
  it("writes its operations and progress note with the watermark and the entries it read", async () => {
    const outcome = await consolidate();

    expect(outcome).toBe("written");
    expect(commitConsolidation).toHaveBeenCalledTimes(1);
    expect(commitConsolidation.mock.calls[0]?.[0]).toEqual({
      userId: USER,
      conversationId: CONVERSATION,
      projectId: PROJECT,
      shown: (await consolidationInput()).full,
      watermarkBefore: 7,
      newWatermark: 19,
      progress: GOOD.progress,
      operations: GOOD.operations,
    });
  });

  it("runs on the consolidation model whatever model the conversation is answered by", async () => {
    // The main model in this suite's config is Opus; the fold stays on the
    // one model the config names for it, and is recorded and charged as it.
    await consolidate();

    expect(getModel).toHaveBeenCalledWith(CONSOLIDATION_MODEL);
    expect(getModel).not.toHaveBeenCalledWith("anthropic/claude-opus-5.5");
    expect(chargeOnce.mock.calls[0]?.[2]).toMatchObject({ model: CONSOLIDATION_MODEL });
  });

  it("records the fold, which spent money and moved the watermark", async () => {
    await consolidate();

    const said = vi.mocked(logger.info).mock.calls.map((call) => call[1]);
    expect(said).toContain("memory_consolidation_written");
  });

  it("names the line for what the fold actually did", async () => {
    commitConsolidation.mockResolvedValue("superseded");

    const outcome = await consolidate();

    expect(outcome).toBe("superseded");
    const said = vi.mocked(logger.info).mock.calls.map((call) => call[1]);
    expect(said).toContain("memory_consolidation_superseded");
    expect(said).not.toContain("memory_consolidation_written");
  });

  it("shows the model the window, the entries in full, the ones by title only and the progress note", async () => {
    await consolidate();

    expect(prompt()).toContain("the whole of page 1");
    expect(prompt()).toContain("they all describe the same technique");
    expect(prompt()).toContain(SHOWN);
    expect(prompt()).toContain("Teal and orange, remember exactly: {messages} $&");
    expect(prompt()).toContain(`${TITLE_ONLY} · Old lens note`);
    expect(prompt()).toContain("what was settled so far");
  });

  it("puts the window where the prompt says the window goes, even when memory holds the placeholder", async () => {
    await consolidate();

    expect(prompt()).toContain("Messages to consolidate:\n[user]");
  });

  it("puts the window in verbatim, dollar signs and all", async () => {
    const withDollars = [{ role: "user" as const, content: "my regex is $`abc$& and $' too" }];

    await consolidate({ turns: [{ turnIndex: 19, messages: withDollars }] });

    expect(prompt()).toContain("my regex is $`abc$& and $' too");
  });

  it("reads a reply as its words, the tools it called and what they answered, nothing else", async () => {
    const window = [
      {
        role: "assistant" as const,
        content: [
          { type: "reasoning" as const, text: "private working", providerOptions: { anthropic: { signature: "s" } } },
          { type: "text" as const, text: "Let me look." },
          {
            type: "tool-call" as const,
            toolCallId: "tc-1",
            toolName: "web_search",
            input: { query: "lighthouse" },
            providerOptions: { openrouter: { reasoning_details: [] } },
          },
        ],
      },
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: "tc-1",
            toolName: "web_search",
            output: { type: "text" as const, value: "three pages about lighthouses" },
          },
        ],
      },
    ];

    await consolidate({ turns: [{ turnIndex: 19, messages: window }] });

    expect(prompt()).toContain("Let me look.");
    expect(prompt()).toContain("web_search");
    expect(prompt()).toContain('{"query":"lighthouse"}');
    expect(prompt()).toContain("three pages about lighthouses");
    expect(prompt()).not.toContain("private working");
    expect(prompt()).not.toContain("providerOptions");
    expect(prompt()).not.toContain("toolCallId");
  });

  it("bounds what the consolidating model may write", async () => {
    await consolidate();

    const call = generateTextRetry.mock.calls[0]?.[0] as { maxOutputTokens?: number };
    expect(call.maxOutputTokens).toBe(OUTPUT_CEILING);
  });

  it("asks the consolidation model for no reasoning the way that model takes it", async () => {
    await consolidate();

    const call = generateTextRetry.mock.calls[0]?.[0] as {
      providerOptions?: Record<string, Record<string, unknown>>;
      temperature?: number;
    };
    expect(call.providerOptions).toEqual({ openrouter: { reasoning: { effort: "none" } } });
    expect(call.temperature).toBe(0);
  });

  it("bills the studio once for the call, under the key of this fold and this attempt", async () => {
    await consolidate();

    expect(chargeOnce.mock.calls[0]?.[0]).toBe("operation");
    const key = chargeOnce.mock.calls[0]?.[1] as string;
    expect(key).toMatch(new RegExp(`^consolidate:${CONVERSATION}:7:${FOLD_ID}:1$`));
    expect(chargeOnce).toHaveBeenCalledTimes(1);
    expect(chargeOnce.mock.calls[0]?.[2]).toMatchObject({ projectId: PROJECT, actorUserId: USER, amount: 400 });
    expect(vi.mocked(createUsageRecorder).mock.calls[0]?.[0]).toMatchObject({
      operationKey: key,
      feature: "memory_consolidation",
      actorUserId: USER,
      projectId: PROJECT,
    });
  });

  it("logs a charge whose users could not be told", async () => {
    chargeOnce.mockResolvedValueOnce({
      billed: true, charged: "400.000000", shortfall: "0.000000", studioId: "s", lotIds: [], signalFailure: new Error("redis down"),
    });
    await consolidate();

    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ projectId: PROJECT }), "credits_signal_failed");
  });

  it("records the call under its generation id, and hands what it could not price to the lookup", async () => {
    const { mocks } = await import("../helpers/mock-core.js");
    const recordModelCall = vi.fn();
    const operation = {
      operationKey: `consolidate:${CONVERSATION}:7:fold:1`,
      feature: "memory_consolidation" as const,
      actorUserId: USER,
      projectId: PROJECT,
    };
    vi.mocked(createUsageRecorder).mockReturnValueOnce({
      operation,
      recordModelCall,
      recordServiceCall: vi.fn(),
      recordLookedUpCall: vi.fn(),
      awaitingLookup: () => ["gen-5"],
      settle: async () => 0,
      settleForCharge: async () => ({ credits: 0, writeFailures: [] }),
    });

    await consolidate();

    expect(recordModelCall).toHaveBeenCalledWith(expect.objectContaining({ generationId: "gen-5", model: CONSOLIDATION_MODEL }));
    expect(mocks.handOffLookups).toHaveBeenCalledWith(
      ["gen-5"],
      operation,
      expect.objectContaining({ description: "Memory consolidation", charge: true }),
    );
    expect(chargeOnce).not.toHaveBeenCalled();
  });
});

describe("an answer that fails its checks", () => {
  it("is asked for again with what was wrong, and the second answer is written", async () => {
    generateTextRetry
      .mockResolvedValueOnce(reply(JSON.stringify({ progress: "p", operations: [{ op: "delete", id: TITLE_ONLY }] })))
      .mockResolvedValueOnce(GOOD_ANSWER);

    const outcome = await consolidate();

    expect(outcome).toBe("written");
    expect(generateTextRetry).toHaveBeenCalledTimes(2);
    const second = sentTo(1);
    expect(second[0]?.content).toBe(prompt());
    expect(second[1]).toEqual({ role: "assistant", content: JSON.stringify({ progress: "p", operations: [{ op: "delete", id: TITLE_ONLY }] }) });
    expect(second[2]?.role).toBe("user");
    expect(second[2]?.content).toContain(TITLE_ONLY);
  });

  it("charges every attempt, each under its own key, both naming the same fold", async () => {
    generateTextRetry.mockResolvedValueOnce(reply("Sure! Here is a summary.")).mockResolvedValueOnce(GOOD_ANSWER);

    await consolidate();

    const [first, second] = chargeOnce.mock.calls.map((call) => call[1] as string);
    expect(first).toMatch(new RegExp(`^consolidate:${CONVERSATION}:7:${FOLD_ID}:1$`));
    expect(second).toBe(first?.replace(/:1$/, ":2"));
  });

  it("charges a second fold from the same watermark under keys of its own", async () => {
    generateTextRetry.mockResolvedValue(reply("not json at all"));
    await consolidate();
    await consolidate();

    const keys = chargeOnce.mock.calls.map((call) => call[1] as string);
    expect(keys).toHaveLength(2 * ATTEMPTS);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("fails after consolidation_answer_attempts answers, writes nothing and leaves memory as it was", async () => {
    generateTextRetry.mockResolvedValue(reply("not json at all"));

    const outcome = await consolidate();

    expect(outcome).toBe("failed");
    expect(generateTextRetry).toHaveBeenCalledTimes(ATTEMPTS);
    expect(commitConsolidation).not.toHaveBeenCalled();
    expect(chargeOnce).toHaveBeenCalledTimes(ATTEMPTS);
    const said = vi.mocked(logger.error).mock.calls.map((call) => call[1]);
    expect(said).toContain("memory_consolidation_failed");
  });

  it("fails at once, without asking again, when the answer was cut off by the output limit", async () => {
    generateTextRetry.mockResolvedValue(reply('{"progress": "p", "operations": [', "length"));

    const outcome = await consolidate();

    expect(outcome).toBe("failed");
    expect(generateTextRetry).toHaveBeenCalledTimes(1);
    expect(commitConsolidation).not.toHaveBeenCalled();
    expect(chargeOnce).toHaveBeenCalledTimes(1);
  });
});

describe("a consolidation that fails", () => {
  it("fails when the model call never succeeds, and charges nothing", async () => {
    generateTextRetry.mockRejectedValue(new Error("502 upstream"));

    const outcome = await consolidate();

    expect(outcome).toBe("failed");
    expect(commitConsolidation).not.toHaveBeenCalled();
    expect(chargeOnce).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it("fails without sending a smaller window when the call is turned away as too long", async () => {
    const { APICallError } = await import("ai");
    generateTextRetry.mockRejectedValue(
      new APICallError({
        message: "This model's maximum context length is 1048576 tokens. However, you requested 1200000 tokens.",
        url: "https://openrouter.ai/api/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 400,
        responseBody: '{"error":{"message":"maximum context length"}}',
        isRetryable: false,
      }),
    );

    const outcome = await consolidate();

    expect(outcome).toBe("failed");
    expect(generateTextRetry).toHaveBeenCalledTimes(1);
  });

  it("fails when the write fails", async () => {
    commitConsolidation.mockRejectedValue(new Error("deadlock detected"));

    const outcome = await consolidate();

    expect(outcome).toBe("failed");
    expect(logger.error).toHaveBeenCalled();
    expect(chargeOnce).toHaveBeenCalledTimes(1);
  });

  it("is untouched when the memory it reads first cannot be read, and calls nothing", async () => {
    consolidationInput.mockRejectedValueOnce(new Error("connection terminated unexpectedly"));

    const outcome = await consolidate();

    expect(outcome).toBe("untouched");
    expect(generateTextRetry).not.toHaveBeenCalled();
    expect(chargeOnce).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });
});

describe("a consolidation the user did not wait for", () => {
  it("does nothing at all once the signal is raised", async () => {
    const controller = new AbortController();
    controller.abort();

    const outcome = await consolidate({ signal: controller.signal });

    expect(outcome).toBe("aborted");
    expect(generateTextRetry).not.toHaveBeenCalled();
    expect(chargeOnce).not.toHaveBeenCalled();
    expect(commitConsolidation).not.toHaveBeenCalled();
  });

  it("hands the signal to the model call so a stop mid-flight lands", async () => {
    const controller = new AbortController();

    await consolidate({ signal: controller.signal });

    const call = generateTextRetry.mock.calls[0]?.[0] as { abortSignal?: AbortSignal };
    expect(call.abortSignal).toBe(controller.signal);
  });

  it("ends as aborted when the user left during the call, told by the signal rather than by a name", async () => {
    const controller = new AbortController();
    generateTextRetry.mockImplementation(async () => {
      controller.abort();
      throw new Error("socket hang up");
    });

    const outcome = await consolidate({ signal: controller.signal });

    expect(outcome).toBe("aborted");
    expect(commitConsolidation).not.toHaveBeenCalled();
  });

  it("does not ask again once the user has left", async () => {
    const controller = new AbortController();
    generateTextRetry.mockImplementation(async () => {
      controller.abort();
      return reply("not json at all");
    });

    const outcome = await consolidate({ signal: controller.signal });

    expect(outcome).toBe("aborted");
    expect(generateTextRetry).toHaveBeenCalledTimes(1);
  });
});

describe("a consolidation whose bill could not be settled", () => {
  it("still counts as written, and says so in the log", async () => {
    const down = new Error("the database is down");
    chargeOnce.mockRejectedValue(down);

    const outcome = await consolidate();

    expect(outcome).toBe("written");
    const [, refKey, charged] = chargeOnce.mock.calls[0] as unknown as [string, string, { amount: number }];
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: down, userId: USER, conversationId: CONVERSATION, refKey, amount: charged.amount }),
      "credit_charge_settle_failed",
    );
  });

  it("charges the full amount when a usage row could not be written, and logs the row", async () => {
    // inner#1617: the recorder counts a row's credits before writing it, so a
    // lost row does not lose the charge.
    const lost = new Error("usage row insert failed");
    const operation = {
      operationKey: `consolidate:${CONVERSATION}:7:fold:1`,
      feature: "memory_consolidation" as const,
      actorUserId: USER,
      projectId: PROJECT,
    };
    vi.mocked(createUsageRecorder).mockReturnValueOnce({
      operation,
      recordModelCall: vi.fn(),
      recordServiceCall: vi.fn(),
      recordLookedUpCall: vi.fn(),
      awaitingLookup: () => [],
      settle: async () => {
        throw lost;
      },
      settleForCharge: async () => ({ credits: 12, writeFailures: [lost] }),
    });

    const outcome = await consolidate();

    expect(outcome).toBe("written");
    expect(chargeOnce).toHaveBeenCalledTimes(1);
    expect(chargeOnce.mock.calls[0]).toEqual([
      "operation",
      operation.operationKey,
      expect.objectContaining({ projectId: PROJECT, actorUserId: USER, amount: 12 }),
    ]);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: lost }), "agent_usage_record_failed");
  });
});

describe("decimal shortfall consumption", () => {
  it("M20 keeps a zero decimal shortfall silent", async () => {
    vi.mocked(logger.error).mockClear();
    chargeOnce.mockResolvedValueOnce({ billed: true, charged: "7.000000", shortfall: "0.000000", studioId: "s", lotIds: [] });
    await consolidate();
    expect(chargeOnce).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.error).mock.calls.filter(([, message]) => message === "CREDIT_SHORTFALL_AFTER_COMPLETION — manual reconciliation required")).toEqual([]);
  });

  it("M20 preserves a one-micro-credit shortfall in the application log", async () => {
    vi.mocked(logger.error).mockClear();
    chargeOnce.mockResolvedValueOnce({ billed: true, charged: "6.999999", shortfall: "0.000001", studioId: "s", lotIds: [] });
    await consolidate();
    expect(chargeOnce).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.error).mock.calls.filter(([, message]) => message === "CREDIT_SHORTFALL_AFTER_COMPLETION — manual reconciliation required")).toEqual([
      [expect.objectContaining({ userId: USER, conversationId: CONVERSATION, studioId: "s", charged: "6.999999", shortfall: "0.000001" }), "CREDIT_SHORTFALL_AFTER_COMPLETION — manual reconciliation required"],
    ]);
  });
});
