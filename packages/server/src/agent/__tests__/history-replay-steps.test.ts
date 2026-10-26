// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";

import { prefixHash, replayRows, stripThinking } from "@server/agent/history-replay.js";
import type { ReplayRow, RequestPrefix } from "@server/agent/history-replay.js";

vi.mock("@breatic/domain", () => ({
  AGENT_TOOL_PICTURE_MARKER: "[Agent pictures from tool results]",
  ASK_USER: "ask_user",
  instructionsText: (instructions: { base: string }): string => instructions.base,
}));

const PREFIX: RequestPrefix = { instructions: { base: "system" }, tools: {}, modelId: "test" };
const QUESTION: ModelMessage = { role: "user", content: "find pictures" };
const CONTINUATION: ModelMessage = { role: "user", content: "continuation clock" };
const FIRST: ModelMessage[] = [
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "first thought", providerOptions: { anthropic: { signature: "first" } } },
      { type: "tool-call", toolCallId: "c1", toolName: "search_images", input: { query: "q" } },
    ],
  },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "search_images", output: { type: "text", value: "pictures" } }] },
];
const LAST: ModelMessage = {
  role: "assistant",
  content: [
    { type: "reasoning", text: "later valid thought", providerOptions: { anthropic: { signature: "last" } } },
    { type: "text", text: "answer" },
  ],
};

interface Step {
  messageStart: number;
  messageEnd: number;
  prefixHash: string;
}

/** A serialized user row and one multi-step reply. */
function rows(messages: ModelMessage[], steps: readonly Step[], initialPrefix = prefixHash(PREFIX, [QUESTION])): ReplayRow[] {
  return [
    { role: "user", content: "q", parts: [], ts: "", turnIndex: 1, forModel: { messages: [QUESTION] } },
    {
      role: "assistant", content: "answer", parts: [], ts: "", turnIndex: 1,
      forModel: JSON.parse(JSON.stringify({ messages, steps, prefixHash: initialPrefix, turnTokens: 10, endTokens: 20 })) as unknown,
    },
  ];
}

describe("stored SDK step generation prefixes", () => {
  it("retains step intervals and generation prefixes through JSON storage and schema replay", () => {
    const steps = [
      { messageStart: 0, messageEnd: 2, prefixHash: prefixHash(PREFIX, [QUESTION]) },
      { messageStart: 2, messageEnd: 3, prefixHash: prefixHash(PREFIX, [QUESTION, ...FIRST]) },
    ];
    const replayed = replayRows(rows([...FIRST, LAST], steps), PREFIX);

    expect(replayed[1]!.reply).toMatchObject({ steps });
    expect(replayed[1]!.messages).toEqual([...FIRST, LAST]);
    expect(replayed[1]!.asSent).toBe(true);
  });

  it("strips only a mismatching earlier step and keeps a later step made under the transformed prefix", () => {
    const steps = [
      { messageStart: 0, messageEnd: 2, prefixHash: "old picture-bearing generation prefix" },
      { messageStart: 2, messageEnd: 3, prefixHash: prefixHash(PREFIX, [QUESTION, ...stripThinking(FIRST)]) },
    ];
    const replayed = replayRows(rows([...FIRST, LAST], steps), PREFIX);

    expect(replayed[1]!.messages).toEqual([...stripThinking(FIRST), LAST]);
    expect(replayed[1]!.asSent).toBe(false);
  });

  it("strips a later step whose recorded prefix still includes the now-invalid first thinking", () => {
    const steps = [
      { messageStart: 0, messageEnd: 2, prefixHash: "old picture-bearing generation prefix" },
      { messageStart: 2, messageEnd: 3, prefixHash: prefixHash(PREFIX, [QUESTION, ...FIRST]) },
    ];
    const replayed = replayRows(rows([...FIRST, LAST], steps), PREFIX);

    expect(replayed[1]!.messages).toEqual(stripThinking([...FIRST, LAST]));
    expect(replayed[1]!.asSent).toBe(false);
  });

  it("uses each complete step's generation prefix even when the row's first-request prefix is stale", () => {
    const steps = [
      { messageStart: 0, messageEnd: 2, prefixHash: prefixHash(PREFIX, [QUESTION]) },
      { messageStart: 2, messageEnd: 3, prefixHash: prefixHash(PREFIX, [QUESTION, ...FIRST]) },
    ];
    const replayed = replayRows(rows([...FIRST, LAST], steps, "older initial request"), PREFIX);

    expect(replayed[1]!.messages).toEqual([...FIRST, LAST]);
  });

  it("interprets resumed reply step offsets after the continuation's own message", () => {
    const steps = [
      { messageStart: 1, messageEnd: 3, prefixHash: "old continuation generation prefix" },
      { messageStart: 3, messageEnd: 4, prefixHash: prefixHash(PREFIX, [QUESTION, CONTINUATION, ...stripThinking(FIRST)]) },
    ];
    const replayed = replayRows(rows([CONTINUATION, ...FIRST, LAST], steps), PREFIX);

    expect(replayed[1]!.messages).toEqual([CONTINUATION, ...stripThinking(FIRST), LAST]);
  });

  it("does not mutate the original stored reasoning while constructing replay copies", () => {
    const stored = rows([...FIRST, LAST], [{ messageStart: 0, messageEnd: 3, prefixHash: "different" }]);
    const before = JSON.stringify(stored);
    const replayed = replayRows(stored, PREFIX);

    expect(replayed[1]!.messages).toEqual(stripThinking([...FIRST, LAST]));
    expect(JSON.stringify(stored)).toBe(before);
    expect(replayed[1]!.messages).not.toBe((stored[1]!.forModel as { messages: ModelMessage[] }).messages);
  });
});
