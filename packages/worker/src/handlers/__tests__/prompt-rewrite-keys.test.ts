// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Nano Banana 2's prompt rewrite on the LLM keys of its task (inner#1953): it runs on the paying account's OpenRouter
 * key when the task holds one, and a failure of that key ends the task with the key's own code instead of quietly
 * sending the catalog's shape, so the user learns the key needs topping up.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KeySet } from "@breatic/provider";

const h = vi.hoisted(() => ({ warn: vi.fn(), prepare: vi.fn(), generate: vi.fn(), record: vi.fn(async () => undefined) }));

vi.mock("@breatic/core", () => ({ logger: { warn: h.warn } }));
vi.mock("@breatic/domain", () => ({
  generateTextRetry: h.generate,
  provider: () => ({ llm: { prepare: h.prepare } }),
}));

import { rewrittenPrompt } from "@worker/handlers/prompt-rewrite.js";

const FALLBACK = JSON.stringify({ subject: "a cat" });
const LATER = Date.now() + 60_000;
const LLM_KEYS: KeySet = { owner: "account", keyOf: (u: string) => (u === "openrouter" ? "acct-or" : undefined) };
const ACCOUNT = { keys: LLM_KEYS, record: h.record };
const rewrite = rewrittenPrompt;
const CUT_OFF = [{ state: "pending", lookup: { upstream: "openrouter", generationId: "gen-1" } }] as const;
const pendingCosts = (): readonly unknown[] => CUT_OFF;

beforeEach(() => {
  vi.clearAllMocks();
  h.prepare.mockReturnValue({ model: "mock-model", options: {}, pendingCosts });
  h.generate.mockResolvedValue({ text: '{"subject":"a cat"}', usage: { totalTokens: 9 }, providerMetadata: { m: 1 } });
});

describe("rewrittenPrompt on a key set", () => {
  it("prepares the call on the task's LLM keys", async () => {
    await rewrite("a cat", {}, FALLBACK, LATER, ACCOUNT);
    expect(h.prepare.mock.calls[0]![3]).toBe(LLM_KEYS);
  });

  it("prepares the call on our keys when the task holds none", async () => {
    await rewrite("a cat", {}, FALLBACK, LATER);
    expect(h.prepare.mock.calls[0]![3]).toBeUndefined();
  });

  it.each([
    ["account_key_failed", { reason: "no_balance", upstream: "openrouter" }],
    ["account_key_missing", {}],
  ])("ends on a %s instead of sending the catalog's shape", async (kind, extra) => {
    h.generate.mockRejectedValue(Object.assign(new Error(kind), { kind, ...extra }));
    await expect(rewrite("a cat", {}, FALLBACK, LATER, ACCOUNT)).rejects.toMatchObject({ kind });
  });

  it("still sends the catalog's shape when the rewrite fails for any other reason", async () => {
    h.generate.mockRejectedValue(new Error("socket hang up"));
    expect((await rewrite("a cat", {}, FALLBACK, LATER, ACCOUNT)).prompt).toBe(FALLBACK);
  });
});

describe("what a rewrite on the payer's key was billed (inner#1953)", () => {
  it("hands the finished call and the prepared call's cut-off answers to the recorder, so each one is recorded", async () => {
    expect(await rewrite("a cat", {}, FALLBACK, LATER, ACCOUNT)).toEqual({ prompt: '{"subject":"a cat"}' });
    expect(h.record).toHaveBeenCalledWith({ ended: { usage: { totalTokens: 9 }, providerMetadata: { m: 1 } }, pending: pendingCosts });
  });

  it("hands what was billed before the rewrite fell back to the catalog's shape", async () => {
    h.generate.mockRejectedValue(new Error("deadline passed"));
    expect((await rewrite("a cat", {}, FALLBACK, LATER, ACCOUNT)).prompt).toBe(FALLBACK);
    expect(h.record).toHaveBeenCalledWith({ pending: pendingCosts });
  });

  it("hands what was billed before a key failure ends the task", async () => {
    h.generate.mockRejectedValue(Object.assign(new Error("no balance"), { kind: "account_key_failed", reason: "no_balance", upstream: "openrouter" }));
    await expect(rewrite("a cat", {}, FALLBACK, LATER, ACCOUNT)).rejects.toMatchObject({ kind: "account_key_failed" });
    expect(h.record).toHaveBeenCalledWith({ pending: pendingCosts });
  });

  it("hands nothing on our keys, where a rewrite is never recorded", async () => {
    expect(await rewrite("a cat", {}, FALLBACK, LATER)).toEqual({ prompt: '{"subject":"a cat"}' });
    expect(h.record).not.toHaveBeenCalled();
  });
});
