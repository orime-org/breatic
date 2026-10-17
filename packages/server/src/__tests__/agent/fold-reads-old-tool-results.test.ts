// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Folding a long conversation into memory reads the history the way a turn
 * sends it, so a tool result written by an older version of its tool reaches
 * the fold too. Pricing each turn and building the fold's transcript both go
 * through the replay conversion, so a structured result stored before the
 * model's copy was kept reaches the fold as the note, and the fold runs
 * (inner#1481).
 */
import { describe, it, expect, vi } from "vitest";
import type * as CoreModule from "@breatic/core";
import type { ReplayRow } from "@server/agent/history-replay.js";
import type { Assembly } from "@server/agent/turn-budget.js";

const AGENT = { modelId: "test", instructions: { base: "system" }, tools: {} };
const QUESTION = { role: "user" as const, content: "and now?" };

/**
 * A history assembled the way a turn assembles it.
 * @param history - The rows since the watermark.
 * @returns The assembly.
 */
function assembled(history: ReplayRow[]): Assembly {
  const replayed = replayRows(history, AGENT);
  return {
    agentConfig: AGENT,
    replayed,
    watermark: 0,
    userKept: { messages: [QUESTION] },
    messages: [...replayed.flatMap((one) => one.messages), QUESTION],
  };
}

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    // Any request is over budget, so the fold runs.
    getAgentConfig: () => ({ ...actual.getAgentConfig(), memory_budget_tokens: 1, memory_keep_tokens: 1 }),
    effectiveKeepTokens: () => 1,
  };
});

const consolidateWindow = vi.fn(async (_request: { transcript: unknown[] }) => ({ kind: "skipped" }));
vi.mock("@server/agent/memory-consolidator.js", () => ({ consolidateWindow }));
vi.mock("@server/agent/consolidation-window.js", () => ({
  planConsolidation: () => ({ newWatermark: 1 }),
}));

const { foldIfOverBudget } = await import("@server/agent/turn-budget.js");
const { prefixHash, replayRows } = await import("@server/agent/history-replay.js");
const { EARLIER_RESULT_NOTE } = await import("@server/agent/stored-model-output.js");

/** A turn whose model listing was written before the listing carried `needs`. */
const HISTORY: ReplayRow[] = [
  {
    id: "u1",
    role: "user",
    parts: [{ type: "text", text: "which models make pictures?" }],
    content: "which models make pictures?",
    ts: "2026-10-07T06:23:00Z",
    turnIndex: 1,
    forModel: null,
  },
  {
    id: "a1",
    role: "assistant",
    parts: [
      {
        type: "tool",
        toolCallId: "tc-1",
        toolName: "list_generation_models",
        input: { nodeType: "image", mode: "t2i" },
        status: "success",
        output: {
          available: true,
          models: [{ name: "m", displayName: "M", what: "x", seconds: 1, params: {} }],
        },
      },
      { type: "text", text: "these ones" },
    ],
    content: "these ones",
    ts: "2026-10-07T06:23:16Z",
    turnIndex: 1,
    forModel: null,
  },
];

describe("folding a history that holds an old tool result", () => {
  it("runs, and hands the fold the note in place of the old result", async () => {
    await foldIfOverBudget(
      assembled(HISTORY),
      { userId: "u", conversationId: "c", projectId: "p" },
    );

    expect(consolidateWindow).toHaveBeenCalledTimes(1);
    const transcript = consolidateWindow.mock.calls[0]?.[0].transcript ?? [];
    const toolMessage = transcript.find((m) => (m as { role: string }).role === "tool") as
      | { content: Array<{ output: unknown }> }
      | undefined;
    expect(toolMessage?.content[0]?.output).toEqual({ type: "text", value: EARLIER_RESULT_NOTE });
  });
});

describe("folding a history kept as it was sent", () => {
  it("hands the fold the reply as it was sent, without its thinking", async () => {
    consolidateWindow.mockClear();
    const asked = { role: "user" as const, content: "what was sent" };
    const answered = [
      {
        role: "assistant" as const,
        content: [
          { type: "reasoning" as const, text: "private working", providerOptions: { anthropic: { signature: "s" } } },
          { type: "text" as const, text: "the answer" },
        ],
      },
    ];
    const kept: ReplayRow[] = [
      { role: "user", content: "q", parts: [{ type: "text", text: "q" }], ts: "", turnIndex: 1, forModel: { messages: [asked] } },
      {
        role: "assistant",
        content: "the answer",
        parts: [{ type: "text", text: "the answer" }],
        ts: "",
        turnIndex: 1,
        forModel: {
          messages: answered,
          prefixHash: prefixHash({ instructions: { base: "system" }, tools: {}, modelId: "test" }, [asked]),
          turnTokens: 1,
          endTokens: 2,
        },
      },
    ];

    await foldIfOverBudget(
      assembled(kept),
      { userId: "u", conversationId: "c", projectId: "p" },
    );

    const transcript = JSON.stringify(consolidateWindow.mock.calls[0]?.[0].transcript);
    expect(transcript).toContain("what was sent");
    expect(transcript).toContain("the answer");
    expect(transcript).not.toContain("private working");
    expect(transcript).not.toContain("signature");
  });
});
