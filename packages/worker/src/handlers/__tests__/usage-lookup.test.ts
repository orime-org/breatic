// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The later lookup of a model call whose cost was not in hand (#296): it retries while
 * provider answers the cost pending, records the call once it does not, and charges it
 * under a key of its own, as an `operation` charge request (inner#1617). A
 * usage row that cannot be written does not stop the charge.
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

import type * as DomainModule from "@breatic/domain";
import type * as CoreModule from "@breatic/core";

const costLookup = vi.hoisted(() => vi.fn());
const fromGeneration = vi.hoisted(() => vi.fn((generationId: string) => ({ upstream: "openrouter", generationId })));
const chargeOnce = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => null));

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  return {
    ...actual,
    provider: () => ({ cost: { lookup: costLookup, fromGeneration } }),
    creditLotService: { chargeOnce },
  };
});

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

import { createUsageRecorder, type UsageLookupJob, type UsageRow } from "@breatic/domain";
import { logger } from "@breatic/core";
import { runUsageLookup } from "@worker/handlers/usage-lookup.js";

const LOOKUP = { upstream: "openrouter", generationId: "gen-9" };
/** The key a lookup's charge goes under: the operation's, then the lookup's hash, as its queued job's id is. */
const LOOKUP_KEY = `turn:c1:4:lookup:${createHash("sha256").update(JSON.stringify(LOOKUP)).digest("hex")}`;

const DATA: UsageLookupJob = {
  lookup: LOOKUP,
  upstream: "openrouter",
  model: "google/gemini-2.5-flash",
  operationKey: "turn:c1:4",
  feature: "chat_turn",
  source: "model",
  actorUserId: "u-1",
  projectId: "p-1",
  description: "Agent chat",
  charge: true,
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
    pricing: { services: { brave_web_search: { per_request: 0 }, brave_image_search: { per_request: 0 } } },
    multiplier: 1,
    write: async (row) => void rows.push(row),
  });
}

/**
 * The real recorder, whose every row write fails.
 * @param options - What the handler opens it with.
 * @returns A recorder.
 */
function recorderThatCannotWrite(
  options: Parameters<typeof createUsageRecorder>[0],
): ReturnType<typeof createUsageRecorder> {
  return createUsageRecorder({
    ...options,
    pricing: { services: { brave_web_search: { per_request: 0 }, brave_image_search: { per_request: 0 } } },
    multiplier: 1,
    write: async () => {
      throw new Error("agent_usage_records insert failed");
    },
  });
}

/**
 * A job at a given attempt.
 * @param attemptsMade - Attempts already made before this one.
 * @returns The job.
 */
function jobAt(attemptsMade: number, data: UsageLookupJob = DATA): Job<UsageLookupJob> {
  return { data, attemptsMade, opts: { attempts: 3 } } as unknown as Job<UsageLookupJob>;
}

/** What provider answers once the generation is billed. */
const KNOWN = { state: "known", usd: 0.03, source: "billing", tokens: TOKENS };

beforeEach(() => {
  vi.clearAllMocks();
  rows = [];
});

describe("looking up a model call whose cost was not in hand", () => {
  it("records the answered cost under the turn and charges it under a key of its own", async () => {
    costLookup.mockResolvedValue(KNOWN);

    await runUsageLookup(jobAt(0), recorderIntoRows);

    expect(costLookup).toHaveBeenCalledWith(LOOKUP, { lastAttempt: false });
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
    expect(chargeOnce).toHaveBeenCalledExactlyOnceWith(
      "operation",
      LOOKUP_KEY,
      expect.objectContaining({ projectId: "p-1", actorUserId: "u-1", amount: 3, provider: "openrouter" }),
    );
  });

  it("charges a lookup of any shape under a key the ledger takes", async () => {
    costLookup.mockResolvedValue(KNOWN);
    const lookup = { upstream: "anthropic", request: { id: "msg 01/ä", at: [1, 2] } };

    await runUsageLookup(jobAt(0, { ...DATA, lookup, upstream: "anthropic" }), recorderIntoRows);

    const refKey = (chargeOnce.mock.calls[0] as unknown as [string, string])[1];
    expect(refKey).toBe(`turn:c1:4:lookup:${createHash("sha256").update(JSON.stringify(lookup)).digest("hex")}`);
    expect(refKey).toMatch(/^[A-Za-z0-9_:.-]{1,255}$/);
  });

  it("logs a charge whose readers could not be told", async () => {
    costLookup.mockResolvedValue(KNOWN);
    chargeOnce.mockResolvedValueOnce({
      billed: true, charged: 3, shortfall: 0, studioId: "s", lotIds: [], signalFailure: new Error("redis down"),
    } as never);

    await runUsageLookup(jobAt(0), recorderIntoRows);

    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p-1" }),
      "credits_signal_failed",
    );
  });

  it("records a call of a run that is not charged, and charges nothing", async () => {
    costLookup.mockResolvedValue(KNOWN);
    const job = { data: { ...DATA, charge: false }, attemptsMade: 0, opts: { attempts: 3 } } as unknown as Job<UsageLookupJob>;

    await runUsageLookup(job, recorderIntoRows);

    expect(rows).toEqual([expect.objectContaining({ costUsd: 0.03, costSource: "generation_lookup" })]);
    expect(chargeOnce).not.toHaveBeenCalled();
  });

  it("asks again later while provider answers the cost pending", async () => {
    costLookup.mockResolvedValue({ state: "pending", lookup: LOOKUP });

    await expect(runUsageLookup(jobAt(0), recorderIntoRows)).rejects.toThrow();

    expect(rows).toEqual([]);
    expect(chargeOnce).not.toHaveBeenCalled();
  });

  it("reads a job queued before lookups named their upstream, charging under the same key", async () => {
    costLookup.mockResolvedValue(KNOWN);
    const { lookup: _lookup, upstream: _upstream, ...rest } = DATA;

    await runUsageLookup(jobAt(0, { ...rest, generationId: "gen-9" }), recorderIntoRows);

    expect(fromGeneration).toHaveBeenCalledWith("gen-9");
    expect(costLookup).toHaveBeenCalledWith(LOOKUP, { lastAttempt: false });
    expect(chargeOnce).toHaveBeenCalledExactlyOnceWith("operation", "turn:c1:4:gen:gen-9", expect.objectContaining({ provider: "openrouter" }));
  });

  it("records the call as missing on the last attempt and says so", async () => {
    costLookup.mockResolvedValue({ state: "missing", reason: "the generation carries no cost yet" });

    await runUsageLookup(jobAt(2), recorderIntoRows);

    expect(rows).toEqual([expect.objectContaining({ costSource: "missing", costUsd: 0 })]);
    expect(costLookup).toHaveBeenCalledWith(LOOKUP, { lastAttempt: true });
    expect(chargeOnce).not.toHaveBeenCalled();
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.objectContaining({ lookup: LOOKUP }),
      "agent_usage_cost_missing",
    );
  });

  it("records a job that names no lookup provider can make as missing, at once", async () => {
    fromGeneration.mockReturnValueOnce(undefined as never);
    const { lookup: _lookup, upstream: _upstream, ...rest } = DATA;

    await runUsageLookup(jobAt(0, { ...rest, generationId: "gen-9" }), recorderIntoRows);

    expect(costLookup).not.toHaveBeenCalled();
    expect(rows).toEqual([expect.objectContaining({ costSource: "missing", costUsd: 0 })]);
    expect(chargeOnce).not.toHaveBeenCalled();
  });

  it("keeps the row when the charge fails, and says so without throwing", async () => {
    costLookup.mockResolvedValue(KNOWN);
    chargeOnce.mockRejectedValueOnce(new Error("db down"));

    await expect(runUsageLookup(jobAt(0), recorderIntoRows)).resolves.toBeUndefined();

    expect(rows).toHaveLength(1);
    const [, refKey, charged] = chargeOnce.mock.calls[0] as unknown as [string, string, { amount: number }];
    expect(refKey).toBe(LOOKUP_KEY);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.objectContaining({ lookup: LOOKUP, refKey, actorUserId: "u-1", amount: charged.amount }),
      "credit_charge_settle_failed",
    );
  });

  // The amount is counted before the row is written, so a write that fails
  // leaves the charge whole: the user had the call, so the call is charged.
  it("still charges the full amount when the usage row cannot be written, and logs the write", async () => {
    costLookup.mockResolvedValue(KNOWN);

    await expect(runUsageLookup(jobAt(0), recorderThatCannotWrite)).resolves.toBeUndefined();

    expect(chargeOnce).toHaveBeenCalledExactlyOnceWith(
      "operation",
      LOOKUP_KEY,
      expect.objectContaining({ projectId: "p-1", actorUserId: "u-1", amount: 3 }),
    );
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "agent_usage_record_failed",
    );
  });
});
