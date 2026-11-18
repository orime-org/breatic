// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A text-tool run on the keys of whoever pays for the project's Studio (inner#1953): with that account's OpenRouter
 * key set, the run's model call goes out on it, its usage is recorded under the key row's id at no credits, nothing is
 * charged, and a call cut off before its cost arrived is handed to the later lookup with the key row's id, uncharged.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const ACCOUNT_KEY = "sk-or-v1-account-key-never-stored";
const ACCOUNT = { owner: "account" as const, keyOf: (upstream: string) => (upstream === "openrouter" ? ACCOUNT_KEY : undefined) };
const DEPLOYMENT = { owner: "deployment" as const, keyOf: () => undefined };
const PROJECT = "11111111-1111-4111-8111-111111111111";

const h = vi.hoisted(() => ({
  prepare: vi.fn(),
  handOffLookups: vi.fn(async (..._args: unknown[]) => undefined),
  chargeOnce: vi.fn(async (..._args: unknown[]) => ({ billed: true, charged: "2000.000000", shortfall: "0.000000", studioId: null, lotIds: [] })),
  opened: [] as Array<Record<string, unknown>>,
  cutOff: { value: false },
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../../../__tests__/helpers/mock-core.js");
  const base = await coreMock(importOriginal);
  return { ...base, env: { ...(base as { env: object }).env, ENV: "test", CREDIT_MULTIPLIER: 1 } };
});

vi.mock("@breatic/domain", async () => ({
  handOffLookups: h.handOffLookups,
  provider: () => ({
    llm: {
      prepare: h.prepare.mockImplementation(() => ({
        model: {},
        options: { providerOptions: {}, maxRetries: 0 },
        system: () => [],
        pendingCosts: () => (h.cutOff.value ? [{ state: "pending", lookup: { upstream: "openrouter", generationId: "gen-cut" } }] : []),
      })),
      costOf: () => ({ state: "known", usd: 0.01, source: "reported", payer: "account", tokens: { input: 0, cachedInput: 0, output: 2000, reasoning: 0 } }),
      servedBy: () => "openrouter",
    },
  }),
  streamTextRetry: (opts: { onLanguageModelCallEnd?: (event: unknown) => void }) => ({
    fullStream: (async function* () {
      if (!h.cutOff.value) {
        opts.onLanguageModelCallEnd?.({ responseId: "gen-done", usage: { inputTokens: 0, outputTokens: 2000, totalTokens: 2000 }, providerMetadata: {} });
      }
      yield { type: "text-delta", text: "ok" };
    })(),
  }),
  // The real recorder's count: a row under an account key row is no credits.
  createUsageRecorder: (options: { operationKey: string; feature: string; actorUserId: string; projectId: string | null; keyId?: string | null }) => {
    h.opened.push(options);
    let credits = 0;
    return {
      operation: { operationKey: options.operationKey, feature: options.feature, actorUserId: options.actorUserId, projectId: options.projectId },
      recordModelCall: (call: { cost: { tokens?: { output: number } } }) => {
        if (options.keyId === undefined || options.keyId === null) credits += call.cost.tokens?.output ?? 0;
      },
      recordServiceCall: () => {},
      awaitingLookup: () => [],
      settle: async () => credits,
      settleForCharge: async () => ({ credits, writeFailures: [] }),
    };
  },
  creditLotService: { chargeOnce: h.chargeOnce },
}));

vi.mock("ai", () => ({ stepCountIs: () => () => false }));
vi.mock("@server/config/text-tools.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getModelForTool: () => "openai/gpt-4o-mini",
  getPromptForTool: () => "system",
}));

const { executeTextTool } = await import("@server/modules/text-tool/text-tool.service.js");

/** The keys the route settles for a payer with an OpenRouter key. */
const ON_ACCOUNT = { keys: ACCOUNT, keyId: "key-1", route: { mode: "default" } } as const;

/**
 * Read one run to its end.
 * @param resolved - The keys the route settled for it.
 * @returns Its events.
 */
async function run(resolved: Parameters<typeof executeTextTool>[6] = ON_ACCOUNT): Promise<Array<{ type: string }>> {
  const events: Array<{ type: string }> = [];
  for await (const event of executeTextTool("u-1", PROJECT, "generate", { instructions: "write" }, new AbortController().signal, "op-1", resolved)) {
    events.push(event);
  }
  return events;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.opened = [];
  h.cutOff.value = false;
});

describe("a text-tool run on the payer's OpenRouter key", () => {
  it("runs on the keys the route settled for the payer", async () => {
    await run();

    expect(h.prepare.mock.calls[0]?.[3]).toBe(ACCOUNT);
  });

  it("records under the key row and charges nothing", async () => {
    const events = await run();

    expect(h.opened).toContainEqual(expect.objectContaining({ feature: "text_tool", keyId: "key-1" }));
    expect(h.chargeOnce).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("hands a cut-off call's lookup over with the key row, uncharged", async () => {
    h.cutOff.value = true;
    await run();

    expect(h.handOffLookups).toHaveBeenCalledWith(expect.any(Array), expect.anything(), expect.objectContaining({ charge: false, keyId: "key-1" }));
  });

  it("is charged, naming no key row, on the deployment's keys", async () => {
    await run({ keys: DEPLOYMENT, keyId: null, route: { mode: "default" } });

    expect(h.chargeOnce).toHaveBeenCalledTimes(1);
    expect(h.opened[0]?.keyId ?? null).toBeNull();
  });
});
