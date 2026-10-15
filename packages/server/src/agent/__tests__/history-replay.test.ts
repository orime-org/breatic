// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from "vitest";
import { tool } from "ai";
import type { ModelMessage } from "ai";
import { z } from "zod";

import {
  lastFullSnapshotKey,
  prefixHash,
  replayRows,
  stripThinking,
  type ReplayRow,
  type RequestPrefix,
} from "@server/agent/history-replay.js";
import { toModelMessages } from "@server/agent/model-messages.js";

const PREFIX: RequestPrefix = {
  instructions: "You are the AI core of Breatic.",
  tools: {
    web_search: tool({ description: "Search the web.", inputSchema: z.object({ query: z.string() }) }),
  },
  modelId: "anthropic/claude-opus-5.5",
};

/**
 * The history the model is sent, oldest first.
 * @param rows - Stored messages, oldest first.
 * @param prefix - What the request carries besides its messages.
 * @returns The messages to send.
 */
function historyForModel(rows: readonly ReplayRow[], prefix: RequestPrefix): ModelMessage[] {
  return replayRows(rows, prefix).flatMap((one) => one.messages);
}

const SIGNED = { anthropic: { signature: "sig-1" } };

/** What the user said on turn one, as it was sent. */
const ASKED: ModelMessage = { role: "user", content: "time note\n\nfind me references\n\n(reminder)" };

/** Turn one's reply as the provider gave it back: thinking, a call, its result, then prose. */
const ANSWERED: ModelMessage[] = [
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "I should search.", providerOptions: SIGNED },
      { type: "tool-call", toolCallId: "tc-1", toolName: "web_search", input: { query: "q", count: 5 } },
    ],
  },
  {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "tc-1", toolName: "web_search", output: { type: "text", value: "r" } }],
  },
  { role: "assistant", content: [{ type: "text", text: "Here they are." }] },
];

/**
 * A stored user row.
 * @param turnIndex - Its turn.
 * @param forModel - What was stored as sent, if anything.
 * @returns The row as the repository hands it out.
 */
function userRow(turnIndex: number, forModel?: unknown): ReplayRow {
  return {
    role: "user",
    content: "find me references",
    parts: [{ type: "text", text: "find me references" }],
    ts: "",
    turnIndex,
    forModel: forModel ?? null,
  };
}

/**
 * A stored reply row.
 * @param turnIndex - Its turn.
 * @param forModel - What was stored as sent, if anything.
 * @returns The row as the repository hands it out.
 */
function replyRow(turnIndex: number, forModel?: unknown): ReplayRow {
  return {
    role: "assistant",
    content: "Here they are.",
    parts: [{ type: "text", text: "Here they are." }],
    ts: "",
    turnIndex,
    forModel: forModel ?? null,
  };
}

/**
 * A reply row stored the way a turn writes it: the hash of the request its
 * first call sent, which held everything before it.
 * @param turnIndex - Its turn.
 * @param before - Every message the first call sent.
 * @param messages - What the turn answered with.
 * @param prefix - What else that request carried.
 * @returns The row.
 */
function replyAfter(
  turnIndex: number,
  before: readonly ModelMessage[],
  messages: ModelMessage[],
  prefix: RequestPrefix = PREFIX,
): ReplayRow {
  return replyRow(turnIndex, { messages, prefixHash: prefixHash(prefix, before), turnTokens: 10, endTokens: 20 });
}

/**
 * Whether any message carries thinking or a provider's private metadata.
 * @param messages - The messages to look through.
 * @returns True when some part or message still does.
 */
function carriesThinking(messages: readonly ModelMessage[]): boolean {
  return JSON.stringify(messages).includes('"reasoning"') || JSON.stringify(messages).includes("providerOptions");
}

describe("replaying the history as it was sent", () => {
  it("sends a user message as it was stored, keys in the order they were written", () => {
    const sent: ModelMessage = { role: "user", content: [{ type: "text", text: "hi", providerOptions: undefined }] };

    const out = historyForModel([userRow(1, { messages: [sent] })], PREFIX);

    expect(JSON.stringify(out)).toBe(JSON.stringify([sent]));
  });

  it("renders a row stored before anything was kept as sent the way it always was", () => {
    const rows = [userRow(1), replyRow(1)];

    expect(historyForModel(rows, PREFIX)).toEqual(toModelMessages(rows));
  });

  it("renders a row whose stored copy is not one we wrote the way it always was", () => {
    const rows = [userRow(1, { messages: "not a list" }), replyRow(1, { messages: [{ nope: true }] })];

    expect(historyForModel(rows, PREFIX)).toEqual(toModelMessages(rows));
  });

  it("keeps a reply's thinking when everything before it is what its turn sent", () => {
    const rows = [userRow(1, { messages: [ASKED] }), replyAfter(1, [ASKED], ANSWERED)];

    const out = historyForModel(rows, PREFIX);

    expect(out).toEqual([ASKED, ...ANSWERED]);
  });

  it("takes a reply's thinking and provider metadata out when what came before it changed", () => {
    const rows = [
      userRow(1, { messages: [{ role: "user", content: "a different question" }] }),
      replyAfter(1, [ASKED], ANSWERED),
    ];

    const out = historyForModel(rows, PREFIX);

    expect(carriesThinking(out)).toBe(false);
    expect(out.slice(1)).toEqual(stripThinking(ANSWERED));
  });

  it.each([
    ["the system prompt", { ...PREFIX, instructions: "Memory changed." }],
    ["the model", { ...PREFIX, modelId: "deepseek/deepseek-v4-pro" }],
    ["the tool set", { ...PREFIX, tools: {} }],
  ])("takes a reply's thinking out when %s is no longer what its turn sent", (_, now) => {
    const rows = [userRow(1, { messages: [ASKED] }), replyAfter(1, [ASKED], ANSWERED)];

    expect(carriesThinking(historyForModel(rows, now))).toBe(false);
  });

  it("keeps the thinking of a reply produced after an earlier one lost its own", () => {
    // Turn two was asked after turn one had already lost its thinking, so
    // its stored hash matches the history as it is now: its thinking was made
    // on that prefix, and the blocks kept are an unbroken run.
    const asked1: ModelMessage = { role: "user", content: "a different question" };
    const asked2: ModelMessage = { role: "user", content: "and more" };
    const rows = [
      userRow(1, { messages: [asked1] }),
      replyAfter(1, [ASKED], ANSWERED),
      userRow(2, { messages: [asked2] }),
      replyAfter(2, [asked1, ...stripThinking(ANSWERED), asked2], ANSWERED),
    ];

    const out = historyForModel(rows, PREFIX);

    expect(out).toEqual([asked1, ...stripThinking(ANSWERED), asked2, ...ANSWERED]);
  });

  it("takes the thinking out of a reply produced while an earlier block was there, once that block is gone", () => {
    const asked1: ModelMessage = { role: "user", content: "a different question" };
    const asked2: ModelMessage = { role: "user", content: "and more" };
    const rows = [
      userRow(1, { messages: [asked1] }),
      replyAfter(1, [ASKED], ANSWERED),
      userRow(2, { messages: [asked2] }),
      replyAfter(2, [asked1, ...ANSWERED, asked2], ANSWERED),
    ];

    expect(carriesThinking(historyForModel(rows, PREFIX))).toBe(false);
  });

  it("sends the next turn as the last request of a multi-step turn that followed a stripped reply, with more at the end", () => {
    const asked1: ModelMessage = { role: "user", content: "a different question" };
    const asked2: ModelMessage = { role: "user", content: "search for it" };
    const before = [asked1, ...stripThinking(ANSWERED), asked2];
    // The turn's second call sent everything before it plus its first step.
    const lastRequest = [...before, ANSWERED[0] as ModelMessage, ANSWERED[1] as ModelMessage];
    const rows = [
      userRow(1, { messages: [asked1] }),
      replyAfter(1, [ASKED], ANSWERED),
      userRow(2, { messages: [asked2] }),
      replyAfter(2, before, ANSWERED),
    ];

    const out = historyForModel(rows, PREFIX);

    expect(JSON.stringify(out.slice(0, lastRequest.length))).toBe(JSON.stringify(lastRequest));
  });

  it("takes the thinking out of a reply that follows a row stored before anything was kept", () => {
    const rows = [userRow(1), replyAfter(1, [ASKED], ANSWERED)];

    expect(carriesThinking(historyForModel(rows, PREFIX))).toBe(false);
  });
});

describe("taking the thinking out", () => {
  it("leaves no reasoning, and no provider metadata on any part or message", () => {
    const openRouterShaped: ModelMessage[] = [
      {
        role: "assistant",
        providerOptions: { openrouter: { usage: 1 } },
        content: [
          { type: "reasoning", text: "thinking", providerOptions: { openrouter: { reasoning_details: [{}] } } },
          {
            type: "tool-call",
            toolCallId: "tc-1",
            toolName: "web_search",
            input: { query: "q" },
            providerOptions: { openrouter: { reasoning_details: [{ signature: "s" }] } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc-1",
            toolName: "web_search",
            output: { type: "text", value: "r" },
            providerOptions: { openrouter: {} },
          },
        ],
      },
    ];

    const out = stripThinking(openRouterShaped);

    expect(carriesThinking(out)).toBe(false);
    expect(out).toEqual([
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "tc-1", toolName: "web_search", input: { query: "q" } }] },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "tc-1", toolName: "web_search", output: { type: "text", value: "r" } }],
      },
    ]);
  });

  it("drops an assistant message that held nothing but thinking", () => {
    const out = stripThinking([
      { role: "assistant", content: [{ type: "reasoning", text: "hmm", providerOptions: SIGNED }] },
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
    ]);

    expect(out).toEqual([{ role: "assistant", content: [{ type: "text", text: "Done." }] }]);
  });

  it("leaves a message whose content is a string as it is", () => {
    const said: ModelMessage = { role: "assistant", content: "plain" };

    expect(stripThinking([said])).toEqual([said]);
  });
});

describe("the hash of a request's prefix", () => {
  it("is the same for the same request and different when any of it changes", () => {
    const base = prefixHash(PREFIX, [ASKED]);

    expect(prefixHash(PREFIX, [ASKED])).toBe(base);
    expect(prefixHash(PREFIX, [ASKED, ...ANSWERED])).not.toBe(base);
    expect(prefixHash({ ...PREFIX, instructions: "x" }, [ASKED])).not.toBe(base);
    expect(prefixHash(PREFIX, [{ role: "user", content: "time note\n\nfind me references" }])).not.toBe(base);
  });

  it("changes when a tool call's arguments are written in another order", () => {
    const reordered: ModelMessage = {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "tc-1", toolName: "web_search", input: { count: 5, query: "q" } }],
    };
    const original: ModelMessage = {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "tc-1", toolName: "web_search", input: { query: "q", count: 5 } }],
    };

    expect(prefixHash(PREFIX, [reordered])).not.toBe(prefixHash(PREFIX, [original]));
  });
});

describe("the most recent full copy of an open Space", () => {
  /**
   * A user row that sent a Space.
   * @param turnIndex - Its turn.
   * @param spaceId - The Space.
   * @param key - What it sent of it.
   * @param full - Whether it sent it in full.
   * @returns The row.
   */
  function sentSpace(turnIndex: number, spaceId: string, key: string, full: boolean): ReplayRow {
    return userRow(turnIndex, { messages: [ASKED], snapshot: { spaceId, key, full } });
  }

  it("is the last one sent in full, past the ones that said it was unchanged", () => {
    const rows = [sentSpace(1, "s1", "A", true), replyRow(1), sentSpace(2, "s1", "A", false)];

    expect(lastFullSnapshotKey(rows, "s1")).toBe("A");
  });

  it("is the latest full one, so A then B then A again is sent in full", () => {
    const rows = [sentSpace(1, "s1", "A", true), sentSpace(2, "s1", "B", true)];

    expect(lastFullSnapshotKey(rows, "s1")).toBe("B");
  });

  it("is of that Space only", () => {
    const rows = [sentSpace(1, "s2", "C", true), sentSpace(2, "s1", "A", true)];

    expect(lastFullSnapshotKey(rows, "s1")).toBe("A");
  });

  it("is none once another Space was sent in full after it, so a same-named Space is never taken for it", () => {
    const rows = [sentSpace(1, "s1", "A", true), sentSpace(2, "s2", "C", true)];

    expect(lastFullSnapshotKey(rows, "s1")).toBeUndefined();
  });

  it("is none when no row in the history sent it", () => {
    expect(lastFullSnapshotKey([userRow(1), replyRow(1)], "s1")).toBeUndefined();
  });
});
