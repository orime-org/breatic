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
 * The number is decided once, when the search runs, and travels on the source.
 * The text the model reads is written down with the turn, so a replayed
 * history reads exactly as the running turn did, however long it gets.
 */

import { describe, it, expect } from "vitest";
import type { MessageData, MessagePart } from "@breatic/shared";
import { makeSearchTools } from "@domain/agent/tools/web-search.js";
import { toModelMessages } from "@server/agent/model-messages.js";
import { withModelOutputs } from "@server/agent/stored-model-output.js";

const tools = { web_search: makeSearchTools().web_search };

/**
 * An assistant message carrying one finished `web_search` call, written the
 * way a turn writes it. A string answer is a row from before the model's copy
 * was kept, so it is stored as it is.
 * @param id - The tool call id.
 * @param output - What the call answered with.
 * @returns The stored message.
 */
async function searchTurn(id: string, output: unknown): Promise<MessageData> {
  const call: MessagePart = {
    type: "tool",
    toolCallId: id,
    toolName: "web_search",
    input: { query: "q", count: 5 },
    output,
    status: "success",
  };
  const [written] = typeof output === "string" ? [call] : await withModelOutputs([call], tools, { conversationId: "c" });
  return { id: `m-${id}`, role: "assistant", content: "", parts: [written] } as unknown as MessageData;
}

/**
 * A structured answer with that many sources.
 * @param n - How many.
 * @param at - What to name them from.
 * @returns The answer as the tool produces it.
 */
function answerWith(n: number, at: string, from = 1): unknown {
  return {
    query: "q",
    sent: n,
    sources: Array.from({ length: n }, (_, i) => ({
      url: `https://${at}${String(i)}.example`,
      title: `${at}${String(i)}`,
      publisher: at,
      excerpts: ["text"],
      index: from + i,
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
  it("prints the number each source was given when its search ran", async () => {
    const texts = toolTexts([
      await searchTurn("a", answerWith(3, "a")),
      await searchTurn("b", answerWith(2, "b", 4)),
    ]);

    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('<source index="1">');
    expect(texts[0]).toContain('<source index="3">');
    expect(texts[1]).toContain('<source index="4">');
    expect(texts[1]).toContain('<source index="5">');
    expect(texts[1]).not.toContain('<source index="1">');
  });

  it("says the same thing however long the history it sits in gets", async () => {
    // The number belongs to the source, so a result replayed inside a longer
    // conversation still reads as the number the model was shown.
    const answer = answerWith(2, "a", 7);
    const alone = toolTexts([await searchTurn("a", answer)]);
    const later = toolTexts([
      await searchTurn("z", answerWith(3, "z")),
      await searchTurn("a", answer),
    ]);

    expect(later[1]).toBe(alone[0]);
  });
});

describe("what the string arms are for", () => {

  it("passes a row written before the structured output through untouched", async () => {
    const older = "Results for: q\n<source index=\"1\">\nurl: https://a.example\n</source>";

    const texts = toolTexts([await searchTurn("a", older)]);

    expect(texts).toEqual([older]);
  });

});
