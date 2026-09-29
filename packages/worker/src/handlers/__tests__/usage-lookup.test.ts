// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The later lookup of an OpenRouter call whose cost was not in hand (#296): it retries while
 * OpenRouter has no answer, records the call once it does, and charges it
 * under a key of its own.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

import type * as DomainModule from "@breatic/domain";
import type * as CoreModule from "@breatic/core";

const lookupGeneration = vi.hoisted(() => vi.fn());
const chargeOnceForGeneration = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => null));

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  return {
    ...actual,
    lookupGeneration: (...args: unknown[]) => lookupGeneration(...args),
    creditLotService: { chargeOnceForGeneration },
  };
});

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    getRawEnvVar: vi.fn(() => "or-key"),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

import { createUsageRecorder, type UsageLookupJob, type UsageRow } from "@breatic/domain";
import { logger } from "@breatic/core";
import { runUsageLookup } from "@worker/handlers/usage-lookup.js";

const DATA: UsageLookupJob = {
  generationId: "gen-9",
  model: "google/gemini-2.5-flash",
  operationKey: "turn:c1:4",
  feature: "chat_turn",
  source: "model",
  actorUserId: "u-1",
  projectId: "p-1",
  description: "Agent chat",
};

const TOKENS = { input: 100, cachedInput: 40, output: 20, reasoning: 5 };

let rows: UsageRow[] = [];

/**
 * The real recorder, writing into `rows`.
 * @param options - What the handler opens it with.
 * @returns A recorder.
 */
function recorderIntoRows(
  options: Parameters<typeof createUsageRecorder>[0],
): ReturnType<typeof createUsageRecorder> {
  return createUsageRecorder({
    ...options,
    pricing: { models: {}, services: { brave_web_search: { per_request: 0 }, brave_image_search: { per_request: 0 } } },
    multiplier: 1,
    write: async (row) => void rows.push(row),
  });
}

/**
 * A job at a given attempt.
 * @param attemptsMade - Attempts already made before this one.
 * @returns The job.
 */
function jobAt(attemptsMade: number): Job<UsageLookupJob> {
  return { data: DATA, attemptsMade, opts: { attempts: 3 } } as unknown as Job<UsageLookupJob>;
}

beforeEach(() => {
  vi.clearAllMocks();
  rows = [];
});

describe("looking up an OpenRouter call whose cost was not in hand", () => {
  it("records the answered cost under the turn and charges it under a key of its own", async () => {
    lookupGeneration.mockResolvedValue({ costUsd: 0.03, tokens: TOKENS });

    await runUsageLookup(jobAt(0), recorderIntoRows);

    expect(lookupGeneration).toHaveBeenCalledWith("gen-9", "or-key");
    expect(rows).toEqual([
      expect.objectContaining({
        operationKey: "turn:c1:4",
        feature: "chat_turn",
        costUsd: 0.03,
        costSource: "generation_lookup",
        inputTokens: 100,
        cachedInputTokens: 40,
        outputTokens: 20,
        reasoningTokens: 5,
      }),
    ]);
    expect(chargeOnceForGeneration).toHaveBeenCalledWith(
      "turn:c1:4:gen:gen-9",
      expect.objectContaining({ projectId: "p-1", actorUserId: "u-1", amount: 3 }),
    );
  });

  it("asks again later while OpenRouter has no answer yet", async () => {
    lookupGeneration.mockResolvedValue(undefined);

    await expect(runUsageLookup(jobAt(0), recorderIntoRows)).rejects.toThrow();

    expect(rows).toEqual([]);
    expect(chargeOnceForGeneration).not.toHaveBeenCalled();
  });

  it("asks again later while OpenRouter found the generation but has no cost on it", async () => {
    lookupGeneration.mockResolvedValue({ costUsd: undefined, tokens: TOKENS });

    await expect(runUsageLookup(jobAt(0), recorderIntoRows)).rejects.toThrow();

    expect(rows).toEqual([]);
  });

  it("records the call as missing on the last attempt and says so", async () => {
    lookupGeneration.mockResolvedValue(undefined);

    await runUsageLookup(jobAt(2), recorderIntoRows);

    expect(rows).toEqual([expect.objectContaining({ costSource: "missing", costUsd: 0 })]);
    expect(chargeOnceForGeneration).not.toHaveBeenCalled();
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.objectContaining({ generationId: "gen-9" }),
      "agent_usage_cost_missing",
    );
  });

  it("treats a lookup that failed on the last attempt as missing", async () => {
    lookupGeneration.mockRejectedValue(new Error("OpenRouter generation lookup answered 500"));

    await runUsageLookup(jobAt(2), recorderIntoRows);

    expect(rows).toEqual([expect.objectContaining({ costSource: "missing" })]);
  });

  it("keeps the row when the charge fails, and says so", async () => {
    lookupGeneration.mockResolvedValue({ costUsd: 0.03, tokens: TOKENS });
    chargeOnceForGeneration.mockRejectedValueOnce(new Error("db down"));

    await runUsageLookup(jobAt(0), recorderIntoRows);

    expect(rows).toHaveLength(1);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.objectContaining({ generationId: "gen-9" }),
      "agent_usage_lookup_charge_failed",
    );
  });
});
