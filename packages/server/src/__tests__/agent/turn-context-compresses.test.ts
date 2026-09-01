// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The assembly really does compress what it read (#148, C3).
 *
 * Every other test of the turn replaces this module with a double, so the one
 * line that shortens tool results is executed by nothing: deleting it and
 * returning the stored history unchanged left the whole suite green. This is
 * the one place that calls it for real.
 */

import { describe, it, expect, vi } from "vitest";
import type * as CoreModule from "@breatic/core";
import type { MessageData, MessagePart } from "@breatic/shared";

const BODY = "the whole page, several thousand characters of it";

/**
 * One tool use, from the call to what came back.
 * @param n - Distinguishes this use from the others.
 * @returns The part as the store hands it out.
 */
function toolPart(n: number): MessagePart {
  return {
    type: "tool",
    toolCallId: `call-${n}`,
    toolName: "web_fetch",
    input: { url: `https://example.test/${n}` },
    status: "success",
    output: `${BODY} ${n}`,
  };
}

/** Six turns, one tool use each: twice the keep window. */
const HISTORY: MessageData[] = Array.from({ length: 6 }, (_, i) => i + 1).flatMap((t) => [
  { role: "user", content: `q${t}`, parts: [{ type: "text", text: `q${t}` }], ts: "", turnIndex: t },
  {
    role: "assistant",
    content: `a${t}`,
    parts: [toolPart(t), { type: "text", text: `a${t}` }],
    ts: "",
    turnIndex: t,
  },
]);

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  const base = await coreMock(importOriginal);
  const actual = await importOriginal<typeof CoreModule>();
  return { ...base, runWithContext: actual.runWithContext, getContext: actual.getContext };
});

vi.mock("@server/modules", () => ({
  conversationService: {
    getConversation: vi.fn(async () => ({ id: "c1", lastConsolidatedTurn: 0 })),
    getMessagesForLlm: vi.fn(async () => HISTORY),
  },
  memoryService: {
    buildContext: vi.fn(async () => ({ projectMemory: "", conversationMemory: "" })),
  },
}));

describe("what the assembly hands the turn", () => {
  it("has the old tool results replaced, and the recent ones whole", async () => {
    const { buildTurnContext } = await import("@server/agent/turn-context.js");

    const { compressedHistory, watermark } = await buildTurnContext("u1", "c1", "p1", 7);

    const results = compressedHistory
      .flatMap((m) => m.parts)
      .filter((p) => p.type === "tool")
      .map((p) => (p.type === "tool" ? String(p.output) : ""));

    expect(results).toHaveLength(6);
    // `tool_result_keep` is 3 in the config double.
    expect(results.slice(-3).every((r) => r.includes(BODY))).toBe(true);
    expect(results.slice(0, -3).some((r) => r.includes(BODY))).toBe(false);
    expect(watermark).toBe(0);
  });
});
