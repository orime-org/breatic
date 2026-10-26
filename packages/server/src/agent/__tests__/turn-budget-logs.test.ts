// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every fold a turn decides on leaves a structured line (inner#1567, A8):
 * which conversation and turn, which model and window, and the count that
 * decided it, so on-call can tell a precheck fold, an overflow fold and a
 * turn that could not be made to fit apart from the logs alone.
 */

import { APICallError } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as CoreModule from "@breatic/core";
import type { ReplayRow } from "@server/agent/history-replay.js";
import type { Assembly } from "@server/agent/turn-budget.js";

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    getAgentConfig: () => ({ ...actual.getAgentConfig(), max_output_tokens: 100, memory_keep_tokens: 400, overflow_folds_per_turn: 2 }),
    memoryReserveTokens: () => 0,
    logger,
  };
});

const consolidateWindow = vi.fn(async (..._args: unknown[]) => "written");
vi.mock("@server/agent/memory-consolidator.js", () => ({ consolidateWindow }));

const { foldIfTooLong } = await import("@server/agent/turn-budget.js");
const { replayRows } = await import("@server/agent/history-replay.js");

const AGENT = { modelId: "test", instructions: { base: "s" }, tools: {}, seesPictures: false, contextWindow: 1_100 };
const WHO = { userId: "u", conversationId: "c", projectId: "p", turnIndex: 3 };

/**
 * A provider's 400 as OpenRouter forwards it.
 * @param provider - The upstream named in the body.
 * @param message - What it said.
 * @returns The error.
 */
function turnedAway(provider: string, message: string): APICallError {
  return new APICallError({
    message,
    url: "https://openrouter.test/v1/chat/completions",
    requestBodyValues: {},
    statusCode: 400,
    responseBody: JSON.stringify({ error: { message, metadata: { provider_name: provider, raw: `{"detail":"${message}"}` } } }),
  });
}

const RELACE = turnedAway("Relace", "prompt is too long: 1500 tokens");
const DIGITAL_OCEAN = turnedAway("DigitalOcean", "prompt is too long: 5000 tokens");

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
    expect(await foldIfTooLong(assembly(), [], WHO, { kind: "precheck", at: "step", known: 1_000 })).toBe("moved");

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "c", turnIndex: 3, model: "test", window: 1_100, known: 1_000, at: "step" }),
      "agent_fold_on_precheck",
    );
  });

  it("logs nothing and folds nothing while the known count leaves room", async () => {
    expect(await foldIfTooLong(assembly(), [], WHO, { kind: "precheck", at: "start", known: 999 })).toBe("none");

    expect(consolidateWindow).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("sends as it stands when the count leaves no room but no earlier turn can be taken", async () => {
    expect(await foldIfTooLong(assembly(), [], { ...WHO, turnIndex: 1 }, { kind: "precheck", at: "start", known: 1_000 })).toBe("none");

    expect(consolidateWindow).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("logs an overflow fold with the provider's own error, the stated size and which attempt it is", async () => {
    const trigger = { kind: "overflow" as const, overflow: { tokens: 1_500, lowerBound: false }, known: undefined, attempt: 2, error: RELACE };

    expect(await foldIfTooLong(assembly(), [], WHO, trigger)).toBe("moved");

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "c",
        model: "test",
        window: 1_100,
        providerError: expect.objectContaining({
          statusCode: 400,
          message: "prompt is too long: 1500 tokens",
          provider_name: "Relace",
          raw: '{"detail":"prompt is too long: 1500 tokens"}',
        }),
        reported: 1_500,
        attempt: 2,
      }),
      "agent_fold_on_overflow",
    );
  });

  it("logs a turn that cannot be made to fit, and pays for no fold", async () => {
    // 5,000 less the two earlier turns is still far over the 1,000 the window leaves.
    const trigger = { kind: "overflow" as const, overflow: { tokens: 5_000, lowerBound: false }, known: undefined, attempt: 1, error: DIGITAL_OCEAN };

    expect(await foldIfTooLong(assembly(), [], WHO, trigger)).toBe("too_long");

    expect(consolidateWindow).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "c",
        providerError: expect.objectContaining({ provider_name: "DigitalOcean", message: "prompt is too long: 5000 tokens" }),
        reported: 5_000,
        takeableTurns: 2,
      }),
      "agent_turn_too_long",
    );
  });

  it("ends an overflow past overflow_folds_per_turn as too long, with the same line, and pays for no fold", async () => {
    const trigger = { kind: "overflow" as const, overflow: { tokens: 1_500, lowerBound: false }, known: undefined, attempt: 3, error: RELACE };

    expect(await foldIfTooLong(assembly(), [], WHO, trigger)).toBe("too_long");

    expect(consolidateWindow).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ providerError: expect.objectContaining({ provider_name: "Relace" }), attempt: 3, takeableTurns: 2 }),
      "agent_turn_too_long",
    );
  });
});
