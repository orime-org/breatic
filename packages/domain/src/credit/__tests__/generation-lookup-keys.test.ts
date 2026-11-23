// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Handing a call an account's own key paid for to the later lookup (inner#1953): the job carries the key row's id,
 * so the worker asks with that key, and is never charged, whatever the operation's other calls are.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const queueAdd = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createQueue: () => ({ add: queueAdd }),
  getAgentConfig: () => ({ usage_lookup_delay_ms: 30_000, usage_lookup_attempts: 6 }),
}));

import { handOffLookups } from "@domain/credit/generation-lookup.js";

const KEY_ID = "44444444-4444-4444-8444-444444444444";
const operation = { operationKey: "turn:c1:2", feature: "chat_turn" as const, actorUserId: "u-1", projectId: "p-1" };
const lookup = { upstream: "openrouter", generationId: "gen-1" };

beforeEach(() => {
  queueAdd.mockClear();
});

describe("a lookup of a call an account's key paid for", () => {
  it("carries the key row's id and is never charged", async () => {
    await handOffLookups([{ lookup, source: "model", model: "deepseek/deepseek-v4.1-flash-1017" }], operation, { description: "Agent chat", charge: true, keyId: KEY_ID });

    expect(queueAdd).toHaveBeenCalledWith("lookup", expect.objectContaining({ keyId: KEY_ID, charge: false }), expect.anything());
    const [, job] = queueAdd.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(JSON.stringify(job)).not.toMatch(/sk-or/);
  });

  it("carries no key row for a call our key paid for, and is charged as asked", async () => {
    await handOffLookups([{ lookup, source: "model", model: "m" }], operation, { description: "Agent chat", charge: true, keyId: null });

    const [, job] = queueAdd.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(job.charge).toBe(true);
    expect(job.keyId ?? null).toBeNull();
  });
});
