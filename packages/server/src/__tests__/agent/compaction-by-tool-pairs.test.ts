// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Compression counts tool use/result pairs, never turns (#148, C1 + C2).
 *
 * The unit is the pair because a turn is not a bounded thing: `stopWhen:
 * stepCountIs(40)` lets one user question run forty model calls, and all of
 * them land in a single assistant row's `parts`. Keeping "the last three
 * turns" therefore keeps up to a hundred and twenty steps verbatim. Anthropic
 * counts the same way — `keep: 3 tool uses` — and no implementation surveyed
 * offers a turn-shaped boundary at all.
 *
 * Every fixture here has more than three turns and more than three pairs, so
 * a turn-shaped implementation and a pair-shaped one disagree on every
 * assertion below.
 */

import { describe, it, expect } from "vitest";
import type { MessageData, MessagePart } from "@breatic/shared";
import { compressForContext } from "../../agent/message-compressor.js";

const KEEP = 3;
const BODY = "body of page";

/**
 * One tool use, from the call to what came back.
 * @param n - Distinguishes this use from the others in a fixture.
 * @returns The part as the store hands it out.
 */
function toolPart(n: number): MessagePart {
  return {
    type: "tool",
    toolCallId: `call-${n}`,
    toolName: "web_fetch",
    input: { url: `https://example.test/${n}` },
    status: "success",
    output: `${BODY} ${n}`.repeat(500),
  };
}

/**
 * A message in the shape the store hands out.
 * @param role - Who is speaking.
 * @param turnIndex - The turn this message belongs to.
 * @param parts - Its pieces, in the order they happened.
 * @returns The message.
 */
function msg(
  role: "user" | "assistant",
  turnIndex: number,
  parts: MessagePart[],
): MessageData {
  const prose = parts.find((p) => p.type === "text");
  return {
    role,
    content: prose?.type === "text" ? prose.text : "",
    parts,
    ts: "2026-08-31T00:00:00Z",
    turnIndex,
  };
}

/**
 * Five turns, one tool use each: more turns than the retired turn window and
 * more pairs than the keep window.
 * @returns The history.
 */
function fiveTurnsOnePairEach(): MessageData[] {
  return Array.from({ length: 5 }, (_, i) => i + 1).flatMap((t) => [
    msg("user", t, [{ type: "text", text: `question ${t}` }]),
    msg("assistant", t, [toolPart(t), { type: "text", text: `answer ${t}` }]),
  ]);
}

/**
 * Every tool part in a compressed history, in order.
 * @param history - What the compressor returned.
 * @returns The tool parts.
 */
function toolPartsOf(history: readonly MessageData[]) {
  return history.flatMap((m) => m.parts.filter((p) => p.type === "tool"));
}

describe("compression keeps the last N tool results, whatever turn they are in", () => {
  it("keeps every pair's call, however many turns back it happened", () => {
    const tools = toolPartsOf(compressForContext(fiveTurnsOnePairEach(), KEEP));

    expect(tools).toHaveLength(5);
    for (const [i, part] of tools.entries()) {
      expect(part.type === "tool" && part.toolName).toBe("web_fetch");
      expect(part.type === "tool" && part.input).toEqual({
        url: `https://example.test/${i + 1}`,
      });
    }
  });

  it("counts pairs across messages, not turns", () => {
    const tools = toolPartsOf(compressForContext(fiveTurnsOnePairEach(), KEEP));

    // Asserted before the slices below: a turn-shaped implementation drops
    // the older turns' parts entirely, which would leave `slice(0, -KEEP)`
    // empty and its loop never run.
    expect(tools).toHaveLength(5);
    // Turns 3, 4 and 5 hold the three most recent uses.
    for (const part of tools.slice(-KEEP)) {
      expect(part.type === "tool" && part.output).toContain(BODY);
    }
    // Turns 1 and 2 are older than the window.
    for (const part of tools.slice(0, -KEEP)) {
      expect(part.type === "tool" && part.output).not.toContain(BODY);
    }
  });

  it("cuts inside one message when a single turn holds more pairs than the window", () => {
    // Ten uses under one user question: what forty steps look like once
    // stored. A turn-shaped rule sees one turn and keeps all ten verbatim.
    const history = [
      msg("user", 1, [{ type: "text", text: "read these ten pages" }]),
      msg("assistant", 1, [
        ...Array.from({ length: 10 }, (_, i) => toolPart(i + 1)),
        { type: "text", text: "here is the summary" },
      ]),
    ];

    const tools = toolPartsOf(compressForContext(history, KEEP));

    expect(tools).toHaveLength(10);
    for (const part of tools.slice(-KEEP)) {
      expect(part.type === "tool" && part.output).toContain(BODY);
    }
    for (const part of tools.slice(0, -KEEP)) {
      expect(part.type === "tool" && part.output).not.toContain(BODY);
    }
  });

  it("changes nothing but the outputs it replaces", () => {
    const history = fiveTurnsOnePairEach();
    const compressed = compressForContext(history, KEEP);

    // Same messages, same order, same parts in the same order — the only
    // difference anywhere is the `output` on pairs older than the window.
    const withoutOutputs = (h: readonly MessageData[]) =>
      h.map((m) => ({
        ...m,
        parts: m.parts.map((p) => (p.type === "tool" ? { ...p, output: null } : p)),
      }));

    expect(withoutOutputs(compressed)).toEqual(withoutOutputs(history));
  });

  it("keeps the marks that say how a turn ended", () => {
    const history = [
      msg("user", 1, [{ type: "text", text: "stopped question" }]),
      msg("assistant", 1, [toolPart(1), { type: "interrupted" }]),
      msg("user", 2, [{ type: "text", text: "failed question" }]),
      msg("assistant", 2, [toolPart(2), { type: "failed" }]),
      msg("user", 3, [{ type: "text", text: "third question" }]),
      msg("assistant", 3, [toolPart(3), { type: "text", text: "third answer" }]),
      msg("user", 4, [{ type: "text", text: "fourth question" }]),
      msg("assistant", 4, [toolPart(4), { type: "text", text: "fourth answer" }]),
      msg("user", 5, [{ type: "text", text: "fifth question" }]),
      msg("assistant", 5, [toolPart(5), { type: "text", text: "fifth answer" }]),
    ];

    const kinds = compressForContext(history, KEEP).flatMap((m) =>
      m.parts.map((p) => p.type),
    );

    expect(kinds).toContain("interrupted");
    expect(kinds).toContain("failed");
  });

  // A regression assertion rather than a red one: a turn-shaped implementation
  // flattens each old turn to its user message and final assistant reply,
  // which for a tool-free history is the history itself. It is kept because
  // the rule says compression touches nothing but tool outputs.
  it("leaves a long history with no tool use exactly as it was", () => {
    const history = Array.from({ length: 5 }, (_, i) => i + 1).flatMap((t) => [
      msg("user", t, [{ type: "text", text: `just talking ${t}` }]),
      msg("assistant", t, [{ type: "text", text: `just answering ${t}` }]),
    ]);

    expect(compressForContext(history, KEEP)).toEqual(history);
  });

  it("replaces the reason a failed call gives back, which is what the model reads", () => {
    // A failed call carries its account in `failure.forModel`; `output` is
    // never set and never read. Left alone, five failed fetches keep five
    // full failure texts in the history forever — and an invalid-arguments
    // failure quotes back everything the model sent.
    const failing = (n: number): MessagePart => ({
      type: "tool",
      toolCallId: `call-${n}`,
      toolName: "web_fetch",
      input: { url: `https://example.test/${n}` },
      status: "error",
      failure: { kind: "tool_failed", forModel: `${BODY} ${n}`.repeat(500), readerKey: "chat.tool.failure.upstream" },
    });
    const history = Array.from({ length: 5 }, (_, i) => i + 1).flatMap((t) => [
      msg("user", t, [{ type: "text", text: `question ${t}` }]),
      msg("assistant", t, [failing(t), { type: "text", text: `answer ${t}` }]),
    ]);

    const tools = toolPartsOf(compressForContext(history, KEEP));

    expect(tools).toHaveLength(5);
    for (const part of tools.slice(-KEEP)) {
      expect(part.type === "tool" && part.failure?.forModel).toContain(BODY);
    }
    for (const part of tools.slice(0, -KEEP)) {
      expect(part.type === "tool" && part.failure?.forModel).not.toContain(BODY);
    }
  });

  it("does not spend a keep slot on a call the model is never shown", () => {
    // `toModelMessages` drops a part that is still pending or whose arguments
    // never finished arriving. Counting them here shrinks the window the
    // operator configured, silently and in the direction that hurts.
    const halfSent: MessagePart = {
      type: "tool",
      toolCallId: "call-half",
      toolName: "web_fetch",
      input: { url: "https://example.test/half" },
      status: "error",
      argumentsIncomplete: true,
      failure: { kind: "tool_failed", forModel: "the call never finished", readerKey: "chat.tool.failure.upstream" },
    };
    const history = [
      ...Array.from({ length: 4 }, (_, i) => i + 1).flatMap((t) => [
        msg("user", t, [{ type: "text", text: `question ${t}` }]),
        msg("assistant", t, [toolPart(t), { type: "text", text: `answer ${t}` }]),
      ]),
      msg("user", 5, [{ type: "text", text: "the one that was cut off" }]),
      msg("assistant", 5, [halfSent]),
    ];

    const tools = toolPartsOf(compressForContext(history, KEEP));
    const shown = tools.filter((p) => p.type === "tool" && p.argumentsIncomplete !== true);

    // Four real uses, three of which keep their body: the incomplete one does
    // not take a slot from them.
    expect(shown).toHaveLength(4);
    const kept = shown.filter((p) => p.type === "tool" && String(p.output ?? "").includes(BODY));
    expect(kept).toHaveLength(KEEP);
  });

  it("returns nothing for an empty history", () => {
    expect(compressForContext([], KEEP)).toEqual([]);
  });
});
