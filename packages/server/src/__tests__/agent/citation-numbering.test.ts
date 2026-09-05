// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One space of numbers for a turn that searched more than once.
 *
 * The model writes `[N]` against the sources it was shown, and it is shown
 * them one search at a time. Numbering each search from one hands it two
 * sources called `1`, and every `[N]` it writes after the first search points
 * at two places at once -- which reads, to whoever follows the citation, as a
 * number the model invented.
 *
 * The count runs across the whole history because that is what the model
 * sees. The number is not stored: it says where a source sits in this turn,
 * which is a fact about the turn rather than about the source, and a stored
 * one would be wrong the moment the same result is replayed inside a longer
 * history.
 */

import { describe, it, expect } from "vitest";
import type { MessageData } from "@breatic/shared";
import { DROPPED_TOOL_RESULT } from "@server/agent/message-compressor.js";
import { toModelMessages } from "@server/agent/model-messages.js";

/**
 * An assistant message carrying one finished `web_search` call.
 * @param id - The tool call id.
 * @param output - What the call answered with.
 * @returns The stored message.
 */
function searchTurn(id: string, output: unknown): MessageData {
  return {
    id: `m-${id}`,
    role: "assistant",
    content: "",
    parts: [
      {
        type: "tool",
        toolCallId: id,
        toolName: "web_search",
        input: { query: "q", count: 5 },
        output,
        status: "success",
      },
    ],
  } as unknown as MessageData;
}

/**
 * A structured answer with that many sources.
 * @param n - How many.
 * @param at - What to name them from.
 * @returns The answer as the tool produces it.
 */
function answerWith(n: number, at: string): unknown {
  return {
    query: "q",
    sent: n,
    sources: Array.from({ length: n }, (_, i) => ({
      url: `https://${at}${String(i)}.example`,
      title: `${at}${String(i)}`,
      publisher: at,
      excerpts: ["text"],
    })),
  };
}

/**
 * The text every tool result in this history carried to the model.
 * @param history - The stored history.
 * @returns One string per tool result, in order.
 */
function toolTexts(history: MessageData[]): string[] {
  return toModelMessages(history)
    .filter((m) => m.role === "tool")
    .flatMap((m) =>
      (m.content as { type: string; output?: { type: string; value?: unknown } }[])
        .map((c) => (c.output?.type === "text" ? String(c.output.value) : ""))
        .filter((t) => t !== ""),
    );
}

describe("numbering across several searches", () => {
  it("carries on from where the previous search stopped", () => {
    const texts = toolTexts([
      searchTurn("a", answerWith(3, "a")),
      searchTurn("b", answerWith(2, "b")),
    ]);

    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('<source index="1">');
    expect(texts[0]).toContain('<source index="3">');
    expect(texts[1]).toContain('<source index="4">');
    expect(texts[1]).toContain('<source index="5">');
    expect(texts[1]).not.toContain('<source index="1">');
  });

  it("counts only the sources that reached the model", () => {
    // Two entries arrived, one was unreadable, so the next search starts at
    // two -- not at three.
    const partial = { query: "q", sent: 2, sources: [
      { url: "https://a.example", title: "A", publisher: "A", excerpts: ["x"] },
    ] };

    const texts = toolTexts([searchTurn("a", partial), searchTurn("b", answerWith(1, "b"))]);

    expect(texts[1]).toContain('<source index="2">');
  });
});

describe("what the string arms are for", () => {
  it("passes the compression placeholder through untouched", () => {
    // The rendering reads `output.sources`. Handing it this string is how a
    // long conversation stops being able to start a turn at all, and the
    // shape that gets here is a plain string, so the check on that comes
    // first.
    const texts = toolTexts([searchTurn("a", DROPPED_TOOL_RESULT)]);

    expect(texts).toEqual([DROPPED_TOOL_RESULT]);
  });

  it("passes a row written before the structured output through untouched", () => {
    const older = "Results for: q\n<source index=\"1\">\nurl: https://a.example\n</source>";

    const texts = toolTexts([searchTurn("a", older)]);

    expect(texts).toEqual([older]);
  });

  it("does not let a placeholder consume a number", () => {
    const texts = toolTexts([
      searchTurn("a", DROPPED_TOOL_RESULT),
      searchTurn("b", answerWith(1, "b")),
    ]);

    expect(texts[1]).toContain('<source index="1">');
  });
});
