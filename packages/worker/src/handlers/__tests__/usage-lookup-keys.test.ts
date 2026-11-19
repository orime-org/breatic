// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The later lookup of a call an account's own key paid for (inner#1953). The queued job holds the key row's id,
 * never the key; the worker reads the key by that id and asks the upstream with it, never with ours. The call is
 * recorded with 0 credits and the key row's id, and charged nothing. A key row replaced or deleted in the meantime
 * cannot be asked with any more: the call is recorded as missing, saying so, and the job ends instead of retrying.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import type { KeySet } from "@breatic/provider";

import type * as DomainModule from "@breatic/domain";
import type * as CoreModule from "@breatic/core";

const h = vi.hoisted(() => ({ costLookup: vi.fn(), chargeOnce: vi.fn(async () => null), keysById: vi.fn() }));

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  return {
    ...actual,
    provider: () => ({ cost: { lookup: h.costLookup, fromGeneration: vi.fn() } }),
    creditLotService: { chargeOnce: h.chargeOnce },
    keysById: h.keysById,
  };
});
vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return { ...actual, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } };
});

import { createUsageRecorder, type UsageLookupJob, type UsageRow } from "@breatic/domain";
import { runUsageLookup } from "@worker/handlers/usage-lookup.js";

const KEY_ID = "33333333-3333-4333-8333-333333333333";
const KEYS: KeySet = { owner: "account", keyOf: (u: string) => (u === "openrouter" ? "sk-or-acct" : undefined) };
const LOOKUP = { upstream: "openrouter", generationId: "gen-9" };
const DATA = {
  lookup: LOOKUP,
  upstream: "openrouter",
  model: "deepseek/deepseek-v4.1-flash-1017",
  operationKey: "turn:c1:4",
  feature: "chat_turn",
  source: "model",
  actorUserId: "u-1",
  projectId: "p-1",
  description: "Agent chat",
  charge: false,
  keyId: KEY_ID,
} as unknown as UsageLookupJob;

let rows: UsageRow[] = [];
let opened: Record<string, unknown>[] = [];

/**
 * The real recorder, writing into `rows` and remembering what it was opened with.
 * @param options - What the handler opens it with.
 * @returns A recorder.
 */
function recorder(options: Parameters<typeof createUsageRecorder>[0]): ReturnType<typeof createUsageRecorder> {
  opened.push(options as unknown as Record<string, unknown>);
  return createUsageRecorder({ ...options, pricing: { services: { brave_web_search: { per_request: 0 }, brave_image_search: { per_request: 0 } } }, multiplier: 1, write: async (row) => void rows.push(row) });
}

/**
 * A job as the queue hands it over.
 * @param data - Its data.
 * @param attemptsMade - Attempts already spent.
 * @returns The job.
 */
const jobOf = (data: UsageLookupJob, attemptsMade = 0): Job<UsageLookupJob> => ({ data, attemptsMade, opts: { attempts: 5 } }) as unknown as Job<UsageLookupJob>;

beforeEach(() => {
  vi.clearAllMocks();
  rows = [];
  opened = [];
  h.keysById.mockResolvedValue({ keys: KEYS });
  h.costLookup.mockResolvedValue({ state: "known", usd: 0.02, source: "billing", payer: "account" });
});

describe("a lookup of a call an account's key paid for", () => {
  it("reads the key by its row id and asks with it", async () => {
    await runUsageLookup(jobOf(DATA), recorder);

    expect(h.keysById).toHaveBeenCalledWith(KEY_ID);
    expect(h.costLookup).toHaveBeenCalledWith(LOOKUP, expect.objectContaining({ keys: KEYS }));
  });

  it("records the call with 0 credits and the key row's id, and charges nothing", async () => {
    await runUsageLookup(jobOf({ ...DATA, charge: true }), recorder);

    expect(opened[0]).toMatchObject({ keyId: KEY_ID });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ credits: 0, keyId: KEY_ID, costUsd: 0.02 });
    expect(h.chargeOnce).not.toHaveBeenCalled();
  });

  it("records the call as missing, says the key is gone, and ends without a retry once the key row was replaced or deleted", async () => {
    h.keysById.mockRejectedValue(Object.assign(new Error("account key gone"), { kind: "account_key_missing" }));

    await expect(runUsageLookup(jobOf(DATA), recorder)).resolves.toBeUndefined();

    expect(h.costLookup).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ costSource: "missing", credits: 0, keyId: KEY_ID });
    expect(h.chargeOnce).not.toHaveBeenCalled();
  });

  it("keeps asking with the same key while the cost is pending", async () => {
    h.costLookup.mockResolvedValue({ state: "pending", lookup: LOOKUP, payer: "account" });

    await expect(runUsageLookup(jobOf(DATA, 0), recorder)).rejects.toThrow();
    await expect(runUsageLookup(jobOf(DATA, 1), recorder)).rejects.toThrow();

    expect(h.costLookup.mock.calls.map(([, opts]) => (opts as { keys?: KeySet }).keys)).toEqual([KEYS, KEYS]);
  });
});

describe("a lookup of a call our key paid for", () => {
  it("asks with our keys and reads no key row", async () => {
    const { keyId: _keyId, ...ours } = DATA;
    h.costLookup.mockResolvedValue({ state: "known", usd: 0.02, source: "billing", payer: "deployment" });

    await runUsageLookup(jobOf(ours), recorder);

    expect(h.keysById).not.toHaveBeenCalled();
    expect((h.costLookup.mock.calls[0]![1] as { keys?: KeySet }).keys).toBeUndefined();
  });
});
