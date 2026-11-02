// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A Space request read back into what the model is sent (inner#1552).
 *
 * What the model reads of a settled request is the row's `for_model`: the
 * settle appended the full result there, the Spaces' content included, while
 * the part the card draws keeps only a summary. A row with no `for_model` is
 * rendered from its parts, and there the request goes back the way a
 * questionnaire does: not while it waits, as its refusal when it was turned
 * away, and once answered with what the part holds -- the summary, since the
 * content was never stored there. A call left with no result at all is told
 * to the model as not answered, the way an unanswered questionnaire is.
 */
import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import type { MessageData } from "@breatic/shared";

import { toModelMessages } from "@server/agent/model-messages.js";
import { replayRows, type ReplayRow, type RequestPrefix } from "@server/agent/history-replay.js";
import { EARLIER_RESULT_NOTE } from "@server/agent/stored-model-output.js";

const REQUEST = { reason: "To read the cast list.", spaces: [{ id: "c1" }, { id: "d1", blocks: { from: 3, to: 5 } }] };

/** What the card keeps once the reader shared: a summary per Space. */
const SUMMARY = {
  spaces: [
    { id: "c1", name: "Cast", kind: "canvas", state: "read" },
    { id: "d1", part: { blocks: { from: 3, to: 5 } }, state: "gone" },
  ],
};

/**
 * One stored message without a kept copy of what was sent.
 * @param parts - Its parts.
 * @returns The message.
 */
function stored(parts: MessageData["parts"]): MessageData {
  return { id: "m1", role: "assistant", parts, content: "", ts: "2026-11-01T00:00:00Z", turnIndex: 1 };
}

/**
 * A stored `request_space_content` part.
 * @param over - Status, output or failure.
 * @returns The part.
 */
function requestPart(over: Record<string, unknown>): MessageData["parts"][number] {
  return { type: "tool", toolCallId: "req-1", toolName: "request_space_content", input: REQUEST, ...over } as unknown as MessageData["parts"][number];
}

/**
 * The output of the result for `req-1`, if one is sent.
 * @param out - What the model is given.
 * @returns The output, or undefined when no result is sent.
 */
function resultOf(out: ModelMessage[]): unknown {
  for (const message of out) {
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;
    const part = message.content.find((p) => p.type === "tool-result" && p.toolCallId === "req-1");
    if (part !== undefined && part.type === "tool-result") return part.output;
  }
  return undefined;
}

describe("a Space request rendered from its parts, for a row with no kept copy", () => {
  it("is left out while it still waits, so no call goes without its result", () => {
    const out = toModelMessages([stored([{ type: "text", text: "Let me look." }, requestPart({ status: "awaiting" })])]);
    expect(out).toEqual([{ role: "assistant", content: "Let me look." }]);
  });

  it("goes back as its refusal when it was turned away", () => {
    const out = toModelMessages([
      stored([requestPart({ status: "error", failure: { kind: "turned_away", forModel: "This card was not shown to the user." } })]),
    ]);
    expect(out).toEqual([
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "req-1", toolName: "request_space_content", input: REQUEST }] },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "req-1",
            toolName: "request_space_content",
            output: { type: "error-text", value: "This card was not shown to the user." },
          },
        ],
      },
    ]);
  });

  it("goes back with the summary it holds once the reader shared, naming each Space and how its read went", () => {
    const out = toModelMessages([stored([requestPart({ status: "success", output: SUMMARY })])]);
    expect(out[0]).toEqual({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "req-1", toolName: "request_space_content", input: REQUEST }],
    });
    const output = resultOf(out);
    expect(output).not.toEqual({ type: "text", value: EARLIER_RESULT_NOTE });
    const said = JSON.stringify(output);
    for (const piece of ['"c1"', '"d1"', '"read"', '"gone"']) expect(said).toContain(piece);
  });

  it("goes back as declined when the reader declined", () => {
    const out = toModelMessages([stored([requestPart({ status: "success", output: { declined: true } })])]);
    expect(resultOf(out)).toEqual({ type: "json", value: { declined: true } });
  });

  it("goes back as replied when the reader wrote a message instead", () => {
    const out = toModelMessages([stored([requestPart({ status: "success", output: { repliedInChat: true } })])]);
    expect(resultOf(out)).toEqual({ type: "json", value: { repliedInChat: true } });
  });

  it("is left out when what it holds is not an answer at all", () => {
    const out = toModelMessages([stored([{ type: "text", text: "Hm." }, requestPart({ status: "success", output: {} })])]);
    expect(out).toEqual([{ role: "assistant", content: "Hm." }]);
  });
});

const PREFIX: RequestPrefix = { instructions: { base: "system" }, tools: {}, modelId: "test" };
const CALL: ModelMessage = {
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: "req-1", toolName: "request_space_content", input: REQUEST }],
};

/**
 * A reply row whose kept copy holds these messages.
 * @param messages - What was sent.
 * @returns The row.
 */
function keptRow(messages: ModelMessage[]): ReplayRow {
  return {
    role: "assistant",
    content: "",
    parts: [requestPart({ status: "success", output: SUMMARY })],
    ts: "",
    turnIndex: 1,
    forModel: { messages, prefixHash: "x", turnTokens: 1, endTokens: 1 },
  };
}

describe("a Space request replayed from the row's kept copy", () => {
  it("sends the full result the settle appended, content and all, not the card's summary", () => {
    const full = {
      spaces: [{ id: "c1", name: "Cast", kind: "canvas", state: "read", content: "THE CAST LIST", total_chars: 13 }],
    };
    const result: ModelMessage = {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "req-1", toolName: "request_space_content", output: { type: "json", value: full } }],
    };
    const [row] = replayRows([keptRow([CALL, result])], PREFIX);
    expect(resultOf(row!.messages)).toEqual({ type: "json", value: full });
  });

  it("answers a call the copy holds no result for as not answered, the way an unanswered questionnaire is", () => {
    const [row] = replayRows([keptRow([CALL])], PREFIX);
    const output = resultOf(row!.messages) as { type: string; value: string };
    expect(output.type).toBe("error-text");
    expect(output.value).toMatch(/did not answer/);
    expect(output.value).not.toBe("This call has no result: the turn ended before it did.");
  });
});
