// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { createHash } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";

const queueAdd = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createQueue: () => ({ add: queueAdd }),
  getAgentConfig: () => ({ usage_lookup_delay_ms: 30_000, usage_lookup_attempts: 6 }),
}));

import { handOffLookups } from "@domain/credit/generation-lookup.js";

beforeEach(() => {
  queueAdd.mockClear();
});

describe("handing calls to the later lookup", () => {
  const operation = { operationKey: "turn:c1:2", feature: "chat_turn" as const, actorUserId: "u-1", projectId: "p-1" };
  const call = { model: "google/gemini-2.5-flash", description: "Agent chat", charge: true };

  it("queues one delayed job per lookup, keyed by the lookup's own hash", async () => {
    const first = { upstream: "openrouter", generationId: "gen-1" };
    await handOffLookups([first, { upstream: "openrouter", generationId: "gen-2" }], operation, call);
    expect(queueAdd).toHaveBeenCalledTimes(2);
    expect(queueAdd).toHaveBeenCalledWith(
      "lookup",
      { ...operation, ...call, lookup: first, upstream: "openrouter", source: "model" },
      expect.objectContaining({ jobId: createHash("sha256").update(JSON.stringify(first)).digest("hex"), delay: 30_000, attempts: 6 }),
    );
  });

  it("queues nothing when there is nothing to look up", async () => {
    await handOffLookups([], operation, call);
    expect(queueAdd).not.toHaveBeenCalled();
  });
});
