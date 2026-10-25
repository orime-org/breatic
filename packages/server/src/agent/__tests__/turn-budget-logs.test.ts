// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every fold a turn decides on leaves a structured line (inner#1567, A8):
 * which conversation and turn, which model and window, and the count that
 * decided it, so on-call can tell a precheck fold, an overflow fold and a
 * turn that could not be made to fit apart from the logs alone.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as CoreModule from "@breatic/core";
import type { ReplayRow } from "@server/agent/history-replay.js";
import type { Assembly } from "@server/agent/turn-budget.js";

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    getAgentConfig: () => ({ ...actual.getAgentConfig(), max_output_tokens: 100, memory_keep_tokens: 400 }),
    memoryReserveTokens: () => 0,
    logger,
  };
});

const consolidateWindow = vi.fn(async (..._args: unknown[]) => "written");
vi.mock("@server/agent/memory-consolidator.js", () => ({ consolidateWindow }));

const { foldIfOverBudget } = await import("@server/agent/turn-budget.js");
const { replayRows } = await import("@server/agent/history-replay.js");

const AGENT = { modelId: "test", instructions: { base: "s" }, tools: {}, seesPictures: false, contextWindow: 1_100 };
const WHO = { userId: "u", conversationId: "c", projectId: "p", turnIndex: 3 };

/**
 * Two earlier turns of 300 characters each, assembled with this turn's question.
 * @returns The assembly.
 */
function assembly(): Assembly {
  const rows: ReplayRow[] = [1, 2].flatMap((turnIndex) => [
    { role: "user" as const, content: "q", parts: [{ type: "text" as const, text: "q" }], ts: "", turnIndex, forModel: null },
    { role: "assistant" as const, content: "a".repeat(300), parts: [{ type: "text" as const, text: "a".repeat(300) }], ts: "", turnIndex, forModel: null },
  ]);
  const replayed = replayRows(rows, AGENT);
  const question = { role: "user" as const, content: "and now?" };
  return {
    agentConfig: AGENT,
    replayed,
    watermark: 0,
    userKept: { messages: [question] },
    messages: [...replayed.flatMap((one) => one.messages), question],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the lines a fold leaves", () => {
  it("logs a precheck fold with the window and the known count", async () => {
    expect(await foldIfOverBudget(assembly(), [], WHO, { kind: "precheck", at: "step", known: 1_000 })).toBe("moved");

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "c", turnIndex: 3, model: "test", window: 1_100, known: 1_000, at: "step" }),
      "agent_fold_on_precheck",
    );
  });

  it("logs nothing and folds nothing while the known count leaves room", async () => {
    expect(await foldIfOverBudget(assembly(), [], WHO, { kind: "precheck", at: "start", known: 999 })).toBe("none");

    expect(consolidateWindow).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("logs an overflow fold with the upstream, the stated size and which attempt it is", async () => {
    const trigger = { kind: "overflow" as const, overflow: { tokens: 1_500, lowerBound: false }, known: undefined, attempt: 2, provider: "Relace" };

    expect(await foldIfOverBudget(assembly(), [], WHO, trigger)).toBe("moved");

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "c", model: "test", window: 1_100, provider: "Relace", reported: 1_500, attempt: 2 }),
      "agent_fold_on_overflow",
    );
  });

  it("logs a turn that cannot be made to fit, and pays for no fold", async () => {
    // 5,000 less the two earlier turns is still far over the 1,000 the window leaves.
    const trigger = { kind: "overflow" as const, overflow: { tokens: 5_000, lowerBound: false }, known: undefined, attempt: 1, provider: "DigitalOcean" };

    expect(await foldIfOverBudget(assembly(), [], WHO, trigger)).toBe("too_long");

    expect(consolidateWindow).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "c", provider: "DigitalOcean", reported: 5_000, takeableTurns: 2 }),
      "agent_turn_too_long",
    );
  });
});
