// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";

import { costPerTurn, requestTokens } from "@server/agent/request-size.js";
import { prefixHash, replayRows } from "@server/agent/history-replay.js";
import type { ReplayedRow, ReplayRow, ReplyForModel, RequestPrefix } from "@server/agent/history-replay.js";
import { measureMessages } from "@server/agent/payload-size.js";
import type { Assembly } from "@server/agent/turn-budget.js";

vi.mock("@breatic/domain", () => ({
  AGENT_TOOL_PICTURE_MARKER: "[Agent pictures from tool results]",
  ASK_USER: "ask_user",
  instructionsText: (instructions: { base: string }): string => instructions.base,
}));

interface Coverage {
  version: 1;
  turnHash?: string;
  endHash?: string;
}

const PREFIX: RequestPrefix = { instructions: { base: "system" }, tools: {}, modelId: "test" };
const QUESTION: ModelMessage = { role: "user", content: "next question" };

/** One user or reply row with already projected messages. */
function row(turnIndex: number, role: "user" | "assistant", messages: ModelMessage[], asSent: boolean, coverage?: Coverage): ReplayedRow {
  const stored: ReplayRow = { turnIndex, role, content: "stored", parts: [], ts: "", forModel: null };
  if (role === "user") return { row: stored, messages, asSent: false };
  const reply: ReplyForModel & { countCoverage?: Coverage } = {
    messages,
    prefixHash: "original prefix",
    turnTokens: 2000,
    endTokens: 9000,
    ...(coverage ? { countCoverage: coverage } : {}),
  };
  return { row: stored, messages, reply, asSent };
}

/** The actual assembly whose last message is this turn's question. */
function assembly(replayed: ReplayedRow[]): Assembly {
  return {
    agentConfig: { ...PREFIX, seesPictures: false, contextWindow: 1_000_000 },
    replayed,
    watermark: 0,
    userKept: { messages: [QUESTION] },
    messages: [...replayed.flatMap((one) => one.messages), QUESTION],
  };
}

/** A JPEG file that has returned to this turn's visible projection. */
function visible(index: number): ModelMessage {
  return { role: "user", content: [{ type: "file", mediaType: "image/jpeg", data: `https://media.example/${String(index)}.jpg` }] };
}

describe("provider counts cover the projection actually sent", () => {
  it("falls back for a new reply explicitly missing turn coverage", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "original question" }, { role: "assistant", content: "answer" }];
    const replayed = [row(1, "user", [messages[0]!], false), row(1, "assistant", [messages[1]!], true, { version: 1 })];

    expect(costPerTurn(replayed)).toEqual([{ turnIndex: 1, tokens: measureMessages(messages) }]);
  });

  it("falls back for a rewritten reply even when old coverage hashes are present", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "changed question" }, { role: "assistant", content: "answer without thinking" }];
    const replayed = [
      row(1, "user", [messages[0]!], false),
      row(1, "assistant", [messages[1]!], false, { version: 1, turnHash: "original turn", endHash: "original end" }),
    ];

    expect(costPerTurn(replayed)).toEqual([{ turnIndex: 1, tokens: measureMessages(messages) }]);
    expect(requestTokens(assembly(replayed))).toBe("system".length + measureMessages(messages) + "next question".length);
  });

  it("estimates the entire ask_user turn once when either reply segment has invalid coverage", () => {
    const user: ModelMessage = { role: "user", content: "original question" };
    const first: ModelMessage = { role: "assistant", content: "questionnaire result" };
    const continuation: ModelMessage = { role: "user", content: "continuation clock and Space" };
    const second: ModelMessage = { role: "assistant", content: "final answer" };
    const replayed = [
      row(3, "user", [user], false),
      row(3, "assistant", [first], true, { version: 1, turnHash: "first coverage", endHash: "first end" }),
      row(3, "assistant", [continuation, second], true, { version: 1 }),
    ];

    expect(costPerTurn(replayed)).toEqual([{ turnIndex: 3, tokens: measureMessages([user, first, continuation, second]) }]);
  });

  it("estimates the whole turn when a later segment has no kept reply metadata", () => {
    const user: ModelMessage = { role: "user", content: "original question" };
    const first: ModelMessage = { role: "assistant", content: "questionnaire result" };
    const continuation: ModelMessage = { role: "user", content: "continuation clock" };
    const second: ModelMessage = { role: "assistant", content: "legacy or interrupted segment" };
    const covered = row(3, "assistant", [first], true, { version: 1, turnHash: "matching first coverage" });
    covered.turnCoverageHash = "matching first coverage";
    const uncovered = row(3, "assistant", [continuation, second], false);
    delete uncovered.reply;

    expect(costPerTurn([row(3, "user", [user], false), covered, uncovered])).toEqual([
      { turnIndex: 3, tokens: measureMessages([user, first, continuation, second]) },
    ]);
  });

  it("counts all restored pictures after the count budget increases", () => {
    const userPictures = [visible(0), visible(1), visible(2)];
    const answer: ModelMessage = { role: "assistant", content: "answer" };
    const replayed = [
      row(1, "user", userPictures, false),
      row(1, "assistant", [answer], false, { version: 1, turnHash: "only two pictures", endHash: "only two pictures and answer" }),
    ];

    expect(costPerTurn(replayed)).toEqual([{ turnIndex: 1, tokens: measureMessages([...userPictures, answer]) }]);
    expect(costPerTurn(replayed)[0]!.tokens).toBeGreaterThan(measureMessages([userPictures[0]!, userPictures[1]!, answer]));
  });

  it("does not use a new reply with incomplete end coverage as a cumulative anchor", () => {
    const user: ModelMessage = { role: "user", content: "question" };
    const answer: ModelMessage = { role: "assistant", content: "answer" };
    const replayed = [row(1, "user", [user], false), row(1, "assistant", [answer], true, { version: 1 })];

    expect(requestTokens(assembly(replayed))).toBe("system".length + measureMessages([user, answer, QUESTION]));
  });

  it("uses an earlier valid cumulative anchor and measures the later incomplete projection", () => {
    const firstUser: ModelMessage = { role: "user", content: "first question" };
    const firstAnswer: ModelMessage = { role: "assistant", content: "first answer" };
    const laterUser: ModelMessage = { role: "user", content: "later question" };
    const laterAnswer: ModelMessage = { role: "assistant", content: "last tool result not yet counted" };
    const earlier = row(1, "assistant", [firstAnswer], true);
    earlier.reply!.endTokens = 500;
    const replayed = [
      row(1, "user", [firstUser], false), earlier,
      row(2, "user", [laterUser], false), row(2, "assistant", [laterAnswer], true, { version: 1 }),
    ];

    expect(requestTokens(assembly(replayed))).toBe(500 + measureMessages([laterUser, laterAnswer, QUESTION]));
  });

  it("keeps legacy provider counts applicable under their existing rules", () => {
    const replayed = [
      row(1, "user", [{ role: "user", content: "old question" }], false),
      row(1, "assistant", [{ role: "assistant", content: "old answer" }], true),
    ];

    expect(costPerTurn(replayed)).toEqual([{ turnIndex: 1, tokens: 2000 }]);
    expect(requestTokens(assembly(replayed))).toBe(9000 + "next question".length);
  });

  it("preserves the explicit invalid coverage marker through stored JSON and schema replay", () => {
    const user: ModelMessage = { role: "user", content: "q" };
    const answer: ModelMessage = { role: "assistant", content: "a" };
    const rows: ReplayRow[] = [
      { role: "user", content: "q", parts: [], ts: "", turnIndex: 1, forModel: { messages: [user] } },
      {
        role: "assistant", content: "a", parts: [], ts: "", turnIndex: 1,
        forModel: JSON.parse(JSON.stringify({ messages: [answer], prefixHash: prefixHash(PREFIX, [user]), turnTokens: 2000, endTokens: 9000, countCoverage: { version: 1 } })) as unknown,
      },
    ];
    const replayed = replayRows(rows, PREFIX);

    expect(replayed[1]!.reply).toMatchObject({ countCoverage: { version: 1 } });
    expect(costPerTurn(replayed)).toEqual([{ turnIndex: 1, tokens: 2 }]);
    expect(requestTokens(assembly(replayed))).toBe("system".length + 2 + "next question".length);
  });
});
