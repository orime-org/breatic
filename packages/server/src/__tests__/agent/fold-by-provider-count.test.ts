// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A fold is decided and sized by the provider's own count (inner#1549, A15;
 * inner#1567).
 *
 * Deciding: the newest reply's `endTokens`, when the provider reported it and
 * its last request is still the prefix this turn replays, is checked against
 * the window less the output reserve. Sizing: the turns are priced by what
 * each added, here on a fold an overflow set off with no stated size.
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
import type { Assembly } from "@server/agent/turn-fold.js";

const LINES = vi.hoisted(() => ({ window: 1100, maxOutput: 100, keep: 400 }));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    getAgentConfig: () => ({
      ...actual.getAgentConfig(),
      max_output_tokens: LINES.maxOutput,
      memory_keep_tokens: LINES.keep,
    }),
    memoryReserveTokens: () => 0,
    // The fold's own log lines (inner#1567, A8); this suite reads the fold.
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

const consolidateWindow = vi.fn(async (_request: { newWatermark: number }) => "written");
vi.mock("@server/agent/memory-consolidator.js", () => ({ consolidateWindow }));

const { foldIfTooLong } = await import("@server/agent/turn-fold.js");
const { knownTokensAtStart, requestTokens } = await import("@server/agent/request-size.js");
const { prefixHash, replayRows } = await import("@server/agent/history-replay.js");

const AGENT: RequestPrefix = { instructions: { base: "s" }, tools: {}, modelId: "test" };
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
        endTokensFrom: "provider",
        lastRequest: { hash: prefixHash(prefix, [...before, asked]), messages: 0 },
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
    agentConfig: { ...AGENT, seesPictures: false, contextWindow: LINES.window },
    replayed,
    watermark: 0,
    userKept: { messages: [QUESTION] },
    messages: [...replayed.flatMap((one) => one.messages), QUESTION],
  };
}

/**
 * Run the check a turn makes before its first call, on a history assembled
 * the way a turn assembles it.
 * @param history - The rows since the watermark.
 * @returns How the check ended.
 */
async function check(history: ReplayRow[]): Promise<string> {
  const assembly = assembled(history);
  const turnIndex = Math.max(0, ...history.map((row) => row.turnIndex)) + 1;
  return foldIfTooLong(assembly, [], { userId: "u", conversationId: "c", projectId: "p", turnIndex }, {
    kind: "precheck",
    at: "start",
    known: knownTokensAtStart(assembly.replayed),
  });
}

/**
 * Fold for a call the provider turned away without saying how big it was.
 * @param history - The rows since the watermark.
 * @returns How the fold ended.
 */
async function overflow(history: ReplayRow[]): Promise<string> {
  const turnIndex = Math.max(0, ...history.map((row) => row.turnIndex)) + 1;
  return foldIfTooLong(assembled(history), [], { userId: "u", conversationId: "c", projectId: "p", turnIndex }, {
    kind: "overflow",
    overflow: { lowerBound: false },
    known: undefined,
    attempt: 1,
    error: undefined,
  });
}

beforeEach(() => {
  consolidateWindow.mockClear();
});

describe("deciding to fold", () => {
  it("leaves a conversation alone that the provider counts under the window, however long its text", async () => {
    // 5,000 characters of answer, but the provider counted the conversation
    // at 900 tokens when the turn ended, under the 1,000 the window leaves.
    expect(await check(keptTurn(1, [], { turnTokens: 900, endTokens: 900 }))).toBe("none");
    expect(consolidateWindow).not.toHaveBeenCalled();
  });

  it("folds once what the provider counted leaves no room under the window", async () => {
    const history = [
      ...keptTurn(1, [], { turnTokens: 600, endTokens: 600 }),
      ...keptTurn(2, [{ role: "user", content: "question 1" }, { role: "assistant", content: LONG }], {
        turnTokens: 400,
        endTokens: 1000,
      }),
    ];

    expect(await check(history)).toBe("moved");
  });

  it("does not read the size off a reply that no longer goes out as it was sent", async () => {
    // Folded since: the system prompt now carries the memory, so this reply's
    // end size counted turns that are gone. What it added is still what it
    // added.
    const history = keptTurn(3, [], { turnTokens: 300, endTokens: 50_000 }, { ...AGENT, instructions: { base: "before the fold" } });

    expect(await check(history)).toBe("none");
    expect(consolidateWindow).not.toHaveBeenCalled();
  });
});

describe("sizing a fold", () => {
  it("takes the oldest turns by what each added until what is left is under the keep line", async () => {
    // Every reply went out under an older system prompt, so the size is what
    // the turns added: 1 + 300 + 300 + 300 + the question, about 909. Taking
    // turn 1 leaves about 600, turn 2 about 300, under the keep line of 400.
    const old = { ...AGENT, instructions: { base: "older" } };
    const history = [
      ...keptTurn(1, [], { turnTokens: 300, endTokens: 300 }, old),
      ...keptTurn(2, [], { turnTokens: 300, endTokens: 600 }, old),
      ...keptTurn(3, [], { turnTokens: 300, endTokens: 900 }, old),
    ];

    await overflow(history);

    expect(consolidateWindow).toHaveBeenCalledTimes(1);
    expect(consolidateWindow.mock.calls[0]?.[0].newWatermark).toBe(2);
  });

  it("folds again after an earlier fold by what each remaining turn added, and stops once under the keep line", async () => {
    // Turns 1 and 2 were folded before: every reply left was made with them
    // there, so none goes out as it was sent and its end count is stale. The
    // size is 1 + 4 x 300 + the question, about 1,209. Taking turn 3 leaves
    // about 909, turn 4 about 609, turn 5 about 309, under the keep line of
    // 400; turn 6 stays.
    const folded: ModelMessage[] = [{ role: "user", content: "question 1" }, { role: "user", content: "question 2" }];
    const history = [3, 4, 5, 6].flatMap((turn) => keptTurn(turn, folded, { turnTokens: 300, endTokens: 300 * turn }));

    await overflow(history);

    expect(consolidateWindow).toHaveBeenCalledTimes(1);
    expect(consolidateWindow.mock.calls[0]?.[0].newWatermark).toBe(5);
  });
});

describe("how big a request is", () => {
  it("is the newest reply sent as it was, by the provider's count, plus what came after it", () => {
    const history = keptTurn(1, [], { turnTokens: 900, endTokens: 900 });

    expect(requestTokens(assembled(history))).toBe(900 + "and now?".length);
  });

  it("adds up what each turn added when no reply goes out as it was sent", () => {
    const history = keptTurn(1, [], { turnTokens: 300, endTokens: 50_000 }, { ...AGENT, instructions: { base: "older" } });

    // The system prompt and the empty tool set, then the turn and the question.
    expect(requestTokens(assembled(history))).toBe(1 + 300 + "and now?".length);
  });
});
