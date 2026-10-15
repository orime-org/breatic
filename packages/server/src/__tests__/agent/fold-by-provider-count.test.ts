// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A fold is decided and sized by the provider's own count (inner#1549, A15).
 *
 * Replayed thinking counts toward the window and is billed as input, and what
 * is stored of it is a summary, so characters undercount it. The last reply
 * kept as sent says how big the conversation was when it ended (`endTokens`);
 * each reply says how much its turn added (`turnTokens`). A reply that no
 * longer goes out as it was sent -- what came before it changed, a fold among
 * them -- no longer says how big the conversation is now.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import type * as CoreModule from "@breatic/core";
import type { ReplayRow, RequestPrefix } from "@server/agent/history-replay.js";
import type { Assembly } from "@server/agent/turn-budget.js";

const LINES = vi.hoisted(() => ({ budget: 1000, keep: 400 }));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    getAgentConfig: () => ({
      ...actual.getAgentConfig(),
      memory_budget_tokens: LINES.budget,
      memory_keep_tokens: LINES.keep,
    }),
    effectiveKeepTokens: () => LINES.keep,
  };
});

const consolidateWindow = vi.fn(async (_request: { newWatermark: number }) => "written");
vi.mock("@server/agent/memory-consolidator.js", () => ({ consolidateWindow }));

const { foldIfOverBudget } = await import("@server/agent/turn-budget.js");
const { requestTokens } = await import("@server/agent/request-size.js");
const { prefixHash, replayRows } = await import("@server/agent/history-replay.js");

const AGENT: RequestPrefix = { instructions: "s", tools: {}, modelId: "test" };
const QUESTION: ModelMessage = { role: "user", content: "and now?" };

/** A long answer, so measuring characters would say something else. */
const LONG = "x".repeat(5000);

/**
 * One stored turn kept as sent.
 * @param turnIndex - Its turn.
 * @param before - Everything its first request sent ahead of the reply.
 * @param sizes - What the provider reported for it.
 * @param sizes.turnTokens - How much the turn added.
 * @param sizes.endTokens - How big the conversation was when it ended.
 * @param prefix - What its request carried besides its messages.
 * @returns The user row and the reply row.
 */
function keptTurn(
  turnIndex: number,
  before: ModelMessage[],
  sizes: { turnTokens: number; endTokens: number },
  prefix: RequestPrefix = AGENT,
): ReplayRow[] {
  const asked: ModelMessage = { role: "user", content: `question ${String(turnIndex)}` };
  return [
    { role: "user", content: "q", parts: [{ type: "text", text: "q" }], ts: "", turnIndex, forModel: { messages: [asked] } },
    {
      role: "assistant",
      content: LONG,
      parts: [{ type: "text", text: LONG }],
      ts: "",
      turnIndex,
      forModel: {
        messages: [{ role: "assistant", content: LONG }],
        prefixHash: prefixHash(prefix, [...before, asked]),
        ...sizes,
      },
    },
  ];
}

/**
 * A history assembled the way a turn assembles it, with this turn's question.
 * @param history - The rows since the watermark.
 * @returns The assembly.
 */
function assembled(history: ReplayRow[]): Assembly {
  const replayed = replayRows(history, AGENT);
  return {
    agentConfig: AGENT,
    replayed,
    watermark: 0,
    userKept: { messages: [QUESTION] },
    messages: [...replayed.flatMap((one) => one.messages), QUESTION],
  };
}

/**
 * Run the fold check on a history, assembled the way a turn assembles it.
 * @param history - The rows since the watermark.
 * @returns Whether the turn must assemble again.
 */
async function check(history: ReplayRow[]): Promise<boolean> {
  return foldIfOverBudget(
    assembled(history),
    { userId: "u", conversationId: "c", projectId: "p" },
  );
}

beforeEach(() => {
  consolidateWindow.mockClear();
});

describe("deciding to fold", () => {
  it("leaves a conversation alone that the provider counts under the budget, however long its text", async () => {
    // 5,000 characters of answer, but the provider counted the conversation
    // at 900 tokens when the turn ended.
    expect(await check(keptTurn(1, [], { turnTokens: 900, endTokens: 900 }))).toBe(false);
    expect(consolidateWindow).not.toHaveBeenCalled();
  });

  it("folds once what the provider counted, with this turn's question, is over the budget", async () => {
    const history = [
      ...keptTurn(1, [], { turnTokens: 600, endTokens: 600 }),
      ...keptTurn(2, [{ role: "user", content: "question 1" }, { role: "assistant", content: LONG }], {
        turnTokens: 395,
        endTokens: 995,
      }),
    ];

    expect(await check(history)).toBe(true);
  });

  it("does not read the size off a reply that no longer goes out as it was sent", async () => {
    // Folded since: the system prompt now carries the memory, so this reply's
    // end size counted turns that are gone. What it added is still what it
    // added.
    const history = keptTurn(3, [], { turnTokens: 300, endTokens: 50_000 }, { ...AGENT, instructions: "before the fold" });

    expect(await check(history)).toBe(false);
  });
});

describe("sizing a fold", () => {
  it("takes the oldest turns by what each added until what is left is under the keep line", async () => {
    // Every reply went out under an older system prompt, so the size is what
    // the turns added: 1 + 300 + 300 + 300 + the question, over 1,000 once
    // the budget is lowered to 800. Taking turn 1 leaves about 600, turn 2
    // about 300, under the keep line of 400.
    LINES.budget = 800;
    const old = { ...AGENT, instructions: "older" };
    const history = [
      ...keptTurn(1, [], { turnTokens: 300, endTokens: 300 }, old),
      ...keptTurn(2, [], { turnTokens: 300, endTokens: 600 }, old),
      ...keptTurn(3, [], { turnTokens: 300, endTokens: 900 }, old),
    ];

    await check(history);
    LINES.budget = 1000;

    expect(consolidateWindow).toHaveBeenCalledTimes(1);
    expect(consolidateWindow.mock.calls[0]?.[0].newWatermark).toBe(2);
  });
});

describe("how big a request is", () => {
  it("is the newest reply sent as it was, by the provider's count, plus what came after it", () => {
    const history = keptTurn(1, [], { turnTokens: 900, endTokens: 900 });

    expect(requestTokens(assembled(history))).toBe(900 + "and now?".length);
  });

  it("adds up what each turn added when no reply goes out as it was sent", () => {
    const history = keptTurn(1, [], { turnTokens: 300, endTokens: 50_000 }, { ...AGENT, instructions: "older" });

    // The system prompt and the empty tool set, then the turn and the question.
    expect(requestTokens(assembled(history))).toBe(1 + 300 + "and now?".length);
  });
});
