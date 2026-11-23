// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A finished generation's bill when some of it was paid with an account's own key (inner#1953): every cost says who
 * paid it, the task is charged only what our keys paid, and a cost still pending is looked up with the keys of
 * whoever paid it (the task's media keys, its LLM keys, or ours), the same keys every time it is asked again.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Cost, KeySet } from "@breatic/provider";

const h = vi.hoisted(() => ({ lookup: vi.fn(), warn: vi.fn() }));

vi.mock("@breatic/core", () => ({
  env: { CREDIT_MULTIPLIER: 1 },
  logger: { warn: h.warn },
  getNodeTaskConfig: () => ({ cost_wait_delay_ms: 1_000, cost_wait_attempts: 3 }),
}));
vi.mock("@breatic/domain", async () => ({
  creditsForUsd: (await import("../../../../domain/src/credit/usage-cost.js")).creditsForUsd,
  provider: () => ({ cost: { lookup: h.lookup } }),
}));

import { billedCredits, lookUp, openWait, pricedCosts, type WaitingCost } from "@worker/handlers/cost-wait.js";

const MEDIA: KeySet = { owner: "account", keyOf: (u: string) => (u === "wavespeed" ? "acct-ws" : undefined) };
const LLM: KeySet = { owner: "account", keyOf: (u: string) => (u === "openrouter" ? "acct-or" : undefined) };
const known = (usd: number, payer: "deployment" | "account"): Cost => ({ state: "known", usd, source: "billing", payer });
const pending = (upstream: string, payer: "deployment" | "account"): Cost => ({ state: "pending", lookup: { upstream, predictionId: `p-${upstream}` }, payer });

type LookUpWithKeys = (entries: readonly WaitingCost[], lastAttempt: boolean, keys: { media?: KeySet; llm?: KeySet }) => Promise<WaitingCost[]>;

beforeEach(() => {
  h.lookup.mockReset();
  h.warn.mockReset();
});

describe("pricedCosts", () => {
  it("charges only what our keys paid, and keeps every pending cost for the wait", () => {
    const priced = pricedCosts("task-1", [known(0.3, "account"), known(0.05, "deployment"), pending("wavespeed", "account")]);
    expect(priced.credits).toBe(5);
    expect(priced.pending).toHaveLength(1);
  });

  it("charges nothing for a run the account's key paid for in full", () => {
    expect(pricedCosts("task-1", [known(0.3, "account"), known(0.2, "account")]).credits).toBe(0);
  });
});

describe("billedCredits", () => {
  it("adds only what the lookups found our keys paid", () => {
    const wait = openWait(5, "wavespeed", 1_000);
    const credits = billedCredits("task-1", wait, [
      { lookup: { upstream: "wavespeed", predictionId: "p-1" }, cost: known(0.4, "account") },
      { lookup: { upstream: "openrouter", generationId: "g-1" }, cost: known(0.01, "deployment") },
    ]);
    expect(credits).toBe(6);
  });
});

describe("lookUp", () => {
  it("asks about each pending cost with the keys of whoever paid it", async () => {
    h.lookup.mockResolvedValue(known(0.1, "account"));
    const entries: WaitingCost[] = [
      { lookup: { upstream: "wavespeed", predictionId: "p-ws" }, cost: pending("wavespeed", "account") },
      { lookup: { upstream: "openrouter", generationId: "g-acct" }, cost: pending("openrouter", "account") },
      { lookup: { upstream: "openrouter", generationId: "g-ours" }, cost: pending("openrouter", "deployment") },
    ];

    await (lookUp as unknown as LookUpWithKeys)(entries, false, { media: MEDIA, llm: LLM });

    const keysOf = (id: string): unknown => (h.lookup.mock.calls.find(([lookup]) => JSON.stringify(lookup).includes(id))![1] as { keys?: KeySet }).keys;
    expect(keysOf("p-ws")).toBe(MEDIA);
    expect(keysOf("g-acct")).toBe(LLM);
    expect(keysOf("g-ours")).toBeUndefined();
  });

  it("records a cost as missing, naming why, once the account key that paid it was replaced or deleted", async () => {
    h.lookup.mockRejectedValue(Object.assign(new Error("gone"), { kind: "account_key_missing" }));
    const entries: WaitingCost[] = [{ lookup: { upstream: "wavespeed", predictionId: "p-ws" }, cost: pending("wavespeed", "account") }];

    await expect((lookUp as unknown as LookUpWithKeys)(entries, false, { media: MEDIA })).resolves.toEqual([
      { lookup: { upstream: "wavespeed", predictionId: "p-ws" }, cost: { state: "missing", reason: expect.stringMatching(/replaced or deleted/), payer: "account" } },
    ]);
  });
});
