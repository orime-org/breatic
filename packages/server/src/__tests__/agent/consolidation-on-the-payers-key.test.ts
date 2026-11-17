// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A memory consolidation runs on the keys of whoever pays for the project's Studio (inner#1953): with that account's
 * OpenRouter key set, the fold's model call goes out on it, its usage rows are written under the key row's id at no
 * credits, nothing is charged and any later lookup is handed the key row's id uncharged. A refused account key ends the
 * fold failed, without moving it to the deployment's key.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as CoreModule from "@breatic/core";
import type * as DomainModule from "@breatic/domain";

const ACCOUNT_KEY = "sk-or-v1-account-key-never-stored";
const ACCOUNT = { owner: "account" as const, keyOf: (upstream: string) => (upstream === "openrouter" ? ACCOUNT_KEY : undefined) };
const MODEL = "deepseek/deepseek-v4.1-flash-1017";

const h = vi.hoisted(() => ({
  generateTextRetry: vi.fn(),
  chargeOnce: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  handOffLookups: vi.fn(async (..._args: unknown[]) => undefined),
  commitConsolidation: vi.fn(async () => "written"),
  resolveKeys: vi.fn(),
  createUsageRecorder: vi.fn(),
  llm: {
    prepare: vi.fn((id: string, _wants?: unknown, _route?: unknown, _keys?: unknown) => ({ model: { modelId: id }, options: { providerOptions: {}, maxRetries: 0 }, pendingCosts: () => [] })),
    costOf: vi.fn(() => ({ state: "known", usd: 0.004, source: "reported", payer: "account", tokens: { input: 150, cachedInput: 0, output: 250, reasoning: 0 } })),
    servedBy: vi.fn(() => "openrouter"),
  },
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  const base = await coreMock(importOriginal);
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...base,
    runWithContext: actual.runWithContext,
    getContext: actual.getContext,
    getAgentConfig: () => ({
      ...(base.getAgentConfig as () => Record<string, unknown>)(),
      max_output_tokens: 4096,
      consolidation_answer_attempts: 1,
      consolidation_max_operations: 50,
      memory_progress_max_chars: 2000,
      consolidation_entries_max_chars: 60000,
      consolidation_model: MODEL,
    }),
  };
});

vi.mock("@breatic/domain", async (importOriginal) => {
  const { domainMock } = await import("../helpers/mock-core.js");
  const base = await domainMock();
  const actual = await importOriginal<typeof DomainModule>();
  return {
    ...base,
    generateTextRetry: h.generateTextRetry,
    provider: () => ({ llm: h.llm }),
    memoryTitle: actual.memoryTitle,
    countCharacters: actual.countCharacters,
    memoryContent: actual.memoryContent,
    creditLotService: { chargeOnce: h.chargeOnce },
    handOffLookups: h.handOffLookups,
    createUsageRecorder: h.createUsageRecorder,
    resolveKeys: h.resolveKeys,
  };
});

vi.mock("@server/modules", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    memoryService: {
      commitConsolidation: h.commitConsolidation,
      consolidationInput: vi.fn(async () => ({ full: [], titlesOnly: [], progress: "" })),
    },
  };
});

const { consolidateWindow } = await import("@server/agent/memory-consolidator.js");

const PROJECT = "33333333-3333-4333-8333-333333333333";

/**
 * Ask for one consolidation.
 * @returns How it ended.
 */
async function consolidate(): Promise<unknown> {
  return consolidateWindow({
    userId: "11111111-1111-4111-8111-111111111111",
    conversationId: "22222222-2222-4222-8222-222222222222",
    projectId: PROJECT,
    turns: [{ turnIndex: 1, messages: [{ role: "user", content: "hello" }] }],
    watermarkBefore: 0,
    newWatermark: 1,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.resolveKeys.mockResolvedValue({ keys: ACCOUNT, keyId: "key-1", route: { mode: "default" } });
  h.generateTextRetry.mockResolvedValue({
    text: JSON.stringify({ progress: "settled", operations: [] }),
    finishReason: "stop",
    usage: { inputTokens: 150, outputTokens: 250, totalTokens: 400 },
    providerMetadata: undefined,
    response: { id: "gen-5" },
  });
  // The real recorder's count: a row under an account key row is no credits.
  h.createUsageRecorder.mockImplementation((options: { operationKey: string; feature: string; actorUserId: string; projectId: string | null; keyId?: string | null }) => {
    let credits = 0;
    return {
      operation: { operationKey: options.operationKey, feature: options.feature, actorUserId: options.actorUserId, projectId: options.projectId },
      recordModelCall: () => {
        if (options.keyId === undefined || options.keyId === null) credits += 400;
      },
      recordServiceCall: () => {},
      recordLookedUpCall: () => {},
      awaitingLookup: () => [],
      settle: async () => credits,
      settleForCharge: async () => ({ credits, writeFailures: [] }),
    };
  });
});

describe("a consolidation on the payer's OpenRouter key", () => {
  it("asks for the payer's language-model keys and folds on them", async () => {
    await consolidate();

    expect(h.resolveKeys).toHaveBeenCalledWith({ projectId: PROJECT }, { kind: "llm" });
    expect(h.llm.prepare.mock.calls[0]?.[3]).toBe(ACCOUNT);
  });

  it("records the call under the key row, charges nothing and hands any lookup over uncharged", async () => {
    expect(await consolidate()).toBe("written");

    expect(h.createUsageRecorder).toHaveBeenCalledWith(expect.objectContaining({ feature: "memory_consolidation", keyId: "key-1" }));
    expect(h.chargeOnce).not.toHaveBeenCalled();
    for (const call of h.handOffLookups.mock.calls) expect(call[2]).toMatchObject({ charge: false, keyId: "key-1" });
  });

  it("ends failed on a refused account key, preparing no second call on other keys", async () => {
    h.generateTextRetry.mockRejectedValue(Object.assign(new Error("Insufficient credits"), { kind: "account_key_failed", reason: "no_balance", upstream: "openrouter" }));

    expect(await consolidate()).toBe("failed");
    expect(h.llm.prepare).toHaveBeenCalledTimes(1);
    expect(h.llm.prepare.mock.calls[0]?.[3]).toBe(ACCOUNT);
    expect(h.chargeOnce).not.toHaveBeenCalled();
  });
});
