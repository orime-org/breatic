// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A provider double for the turn's model calls: `prepare` hands back the test's model, the system prompt whole as
 * one message (what the real one sends where nothing is marked), and every call it is asked about served by one
 * upstream. Its cost answers come from what the test model put in `providerMetadata.test.costUsd`: known when it
 * states one, missing otherwise. How provider really routes, marks and prices is provider's, and its tests hold it.
 */

import { vi } from "vitest";
// A relative path because this stub must not pull the domain barrel; test code is exempt from the alias rule.
import { instructionsText } from "../../../../domain/src/agent/instructions.js";

/** The upstream every call of the double is served by. */
export const TEST_UPSTREAM = "test-upstream";

/** The parts of a system prompt, as the turn hands them over. */
type Parts = { base: string; project?: string; conversation?: string; projectInstructions?: string };

/**
 * A provider whose model calls run on the test's model.
 * @param modelOf - The model a call of a model id runs on.
 * @param system - How it lays out a system prompt, when a test asserts on that.
 * @returns The `provider` accessor a domain mock exports.
 */
export function fakeProvider(
  modelOf: (modelId: string) => unknown,
  system: (parts: Parts) => unknown[] = (parts) => [{ role: "system", content: instructionsText(parts) }],
): () => { llm: Record<string, unknown> } {
  const llm = {
    prepare: vi.fn((modelId: string) => ({
      model: modelOf(modelId),
      options: { providerOptions: {}, maxRetries: 0 },
      system,
      pendingCosts: () => [],
    })),
    costOf: vi.fn((finished: { usage: { inputTokens?: number; outputTokens?: number }; providerMetadata?: Record<string, unknown> }) => {
      const usd = (finished.providerMetadata?.test as { costUsd?: unknown } | undefined)?.costUsd;
      const tokens = { input: finished.usage.inputTokens ?? 0, cachedInput: 0, output: finished.usage.outputTokens ?? 0, reasoning: 0 };
      return typeof usd === "number"
        ? { state: "known", usd, source: "reported", tokens }
        : { state: "missing", reason: "the test model stated no cost", tokens };
    }),
    servedBy: vi.fn(() => TEST_UPSTREAM),
    assertModelsPriced: vi.fn(),
  };
  return () => ({ llm });
}

/**
 * A provider for domain's own assembly of a turn (`buildAgentConfig`), handed to the real domain's `initProvider`:
 * a model whose pictures and window nobody can say, and no upstream with a key for a tool that needs one -- what a
 * deployment with only the test environment's keys has.
 * @returns The provider, typed loosely for `initProvider`.
 */
export function assemblyProvider(): never {
  const none = { upstreams: [] };
  return { llm: { capabilities: async () => ({ pictures: false }), availability: () => none, judgeAvailability: () => none } } as never;
}
