// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the assembly reads for a turn.
 *
 * Every other test of the turn replaces this module with a double, so this is
 * the one place it runs for real. The history goes to the model as stored:
 * a turn is replayed as it was sent so the provider's cached prefix still
 * matches, and shortening an old tool result would change it (inner#1549).
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
    toolName: "web_search",
    input: { url: `https://example.test/${n}` },
    status: "success",
    output: { page: `${BODY} ${n}` },
    forModel: { type: "text", value: `${BODY} ${n}` },
  };
}

/** Six turns, one tool use each. */
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
  it("hands over every tool result whole, old ones included", async () => {
    const { buildTurnContext } = await import("@server/agent/turn-context.js");

    const { history, watermark } = await buildTurnContext("u1", "c1", "p1", 7);

    const results = history
      .flatMap((m) => m.parts)
      .filter((p) => p.type === "tool")
      .map((p) => (p.type === "tool" && p.forModel?.type === "text" ? p.forModel.value : ""));

    expect(results).toHaveLength(6);
    expect(results.every((r) => r.includes(BODY))).toBe(true);
    expect(watermark).toBe(0);
  });

  it("reads the watermark before the memory it is supposed to agree with", async () => {
    // A fold running in another tab commits between these two reads. Taking
    // the memory first pairs a memory from before the fold with a watermark
    // from after it, and the turns in between are in neither: gone from the
    // history because the watermark passed them, absent from the memory
    // because it was read before the fold wrote it. The other order pairs a
    // memory that is at least as new as the watermark, so the worst case is
    // an overlap — those turns in both — which costs context and loses
    // nothing.
    // Recorded at three moments, so what is pinned is the watermark read
    // having *finished* before the memory read starts. Recording only which
    // call was made first would pass on two reads issued together, and two
    // reads issued together are the gap: the fold in the other tab can commit
    // between them just as it can between two sequential ones.
    const { conversationService, memoryService } = await import("@server/modules");
    const order: string[] = [];
    vi.mocked(conversationService.getConversation).mockImplementationOnce(async () => {
      order.push("watermark:start");
      await Promise.resolve();
      order.push("watermark:done");
      return { id: "c1", lastConsolidatedTurn: 0 } as never;
    });
    vi.mocked(memoryService.buildContext).mockImplementationOnce(async () => {
      order.push("memory:start");
      return { projectMemory: "", conversationMemory: "" };
    });

    const { buildTurnContext } = await import("@server/agent/turn-context.js");
    await buildTurnContext("u1", "c1", "p1", 7);

    expect(order).toEqual(["watermark:start", "watermark:done", "memory:start"]);
  });
});
