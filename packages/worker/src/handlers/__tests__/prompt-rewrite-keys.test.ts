// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Nano Banana 2's prompt rewrite on the LLM keys of its task (inner#1953): it runs on the paying account's OpenRouter
 * key when the task holds one, and a failure of that key ends the task with the key's own code instead of quietly
 * sending the catalog's shape, so the user learns the key needs topping up.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KeySet } from "@breatic/provider";

const h = vi.hoisted(() => ({ warn: vi.fn(), prepare: vi.fn(), generate: vi.fn() }));

vi.mock("@breatic/core", () => ({ logger: { warn: h.warn } }));
vi.mock("@breatic/domain", () => ({
  generateTextRetry: h.generate,
  provider: () => ({ llm: { prepare: h.prepare } }),
}));

import { rewrittenPrompt } from "@worker/handlers/prompt-rewrite.js";

const FALLBACK = JSON.stringify({ subject: "a cat" });
const LATER = Date.now() + 60_000;
const LLM_KEYS: KeySet = { owner: "account", keyOf: (u: string) => (u === "openrouter" ? "acct-or" : undefined) };
const rewrite = rewrittenPrompt;

beforeEach(() => {
  vi.clearAllMocks();
  h.prepare.mockReturnValue({ model: "mock-model", options: {} });
  h.generate.mockResolvedValue({ text: '{"subject":"a cat"}' });
});

describe("rewrittenPrompt on a key set", () => {
  it("prepares the call on the task's LLM keys", async () => {
    await rewrite("a cat", {}, FALLBACK, LATER, LLM_KEYS);
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
    await expect(rewrite("a cat", {}, FALLBACK, LATER, LLM_KEYS)).rejects.toMatchObject({ kind });
  });

  it("still sends the catalog's shape when the rewrite fails for any other reason", async () => {
    h.generate.mockRejectedValue(new Error("socket hang up"));
    expect(await rewrite("a cat", {}, FALLBACK, LATER, LLM_KEYS)).toBe(FALLBACK);
  });
});
