// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { generateText } from "ai";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Cost } from "../../cost.js";
import type { KeySet } from "../../index.js";
import { createProvider, type Provider } from "../../provider.js";
import { accountKeys, deploymentKeyOf, keyFailureOf, malformedKeyArb, settled, textOf } from "../../__tests__/keys-harness.js";
import { openrouter } from "../upstreams/openrouter.js";
import { CHAT_REPLY, llmConfig, posted, startFakes, stopFakes, type LlmFakes } from "./llm-harness.js";

// LLM calls on the key set the caller hands each call (inner#1953): an account's OpenRouter key is the only key its
// calls use, a failure of it is told apart and never moves to another upstream or the deployment's key, and each key
// gets its own client.

let fakes: LlmFakes;

beforeEach(async () => {
  fakes = await startFakes();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await stopFakes(fakes);
});

const DEPLOYMENT = { ANTHROPIC_API_KEY: "dep-an", DEEPSEEK_API_KEY: "dep-ds", GOOGLE_API_KEY: "dep-g", OPENAI_API_KEY: "dep-oa", OPENROUTER_API_KEY: "dep-or" };
const THINK = { thinking: true, cache: false } as const;
const DEFAULT = { mode: "default" } as const;
const picture = { bytes: new Uint8Array(32), contentType: "image/png" };

/**
 * A provider over the fakes reading the deployment's keys through a spy.
 * @param llmMaxRetries - Retries on one upstream.
 * @returns The provider and the spy, cleared of whatever building the provider read.
 */
function started(llmMaxRetries = 2): { provider: Provider; deploymentKeys: ReturnType<typeof deploymentKeyOf> } {
  const deploymentKeys = deploymentKeyOf(DEPLOYMENT);
  const provider = createProvider({ config: llmConfig(fakes), keyOf: deploymentKeys, llmMaxRetries, cleanText: (t) => t });
  deploymentKeys.mockClear();
  return { provider, deploymentKeys };
}

/**
 * One chat call on a key set.
 * @param provider - The provider.
 * @param keys - The key set.
 * @param model - Our model id.
 * @returns What generateText answered.
 */
async function chat(provider: Provider, keys: KeySet | undefined, model = "deepseek/deepseek-v4-pro"): Promise<Awaited<ReturnType<typeof generateText>>> {
  const prepared = (provider.llm.prepare as (...args: unknown[]) => ReturnType<Provider["llm"]["prepare"]>)(model, THINK, DEFAULT, keys);
  return generateText({ model: prepared.model, prompt: "hi", ...prepared.options });
}

/**
 * An understand call on a key set.
 * @param provider - The provider.
 * @param keys - The key set.
 * @returns The answer.
 */
function understand(provider: Provider, keys: KeySet | undefined): ReturnType<Provider["llm"]["understand"]> {
  const request = { model: "google/gemini-3.8-flash", question: "What is in it?", media: [picture], maxOutputTokens: 200, deadlineAt: Date.now() + 60_000 };
  return (provider.llm.understand as (...args: unknown[]) => ReturnType<Provider["llm"]["understand"]>)(request, DEFAULT, keys);
}

/**
 * Every authorization header a fake received on a model request.
 * @param fake - The fake.
 * @returns The headers, in order.
 */
const auths = (fake: LlmFakes[keyof LlmFakes]): (string | undefined)[] => fake.seen.filter((s) => s.method === "POST").map((s) => s.authorization);

/**
 * Every fake but OpenRouter.
 * @returns Their requests.
 */
const othersSeen = (): unknown[] => [fakes.anthropic, fakes.deepseek, fakes.google, fakes.openai].flatMap((f) => f.seen);

describe("an account's key set on LLM calls", () => {
  it("prepare: sends only to the upstream the set has a key for, with that key, reading no deployment key", async () => {
    const { provider, deploymentKeys } = started();
    const result = await chat(provider, accountKeys({ openrouter: "acct-or" }));
    expect(result.providerMetadata?.breatic?.upstream).toBe("openrouter");
    // DeepSeek is the route's first upstream and has the deployment's key, but the account has none for it.
    expect(othersSeen()).toHaveLength(0);
    expect(auths(fakes.openrouter)).toEqual(["Bearer acct-or"]);
    expect(deploymentKeys).not.toHaveBeenCalled();
  });

  it("understand: sends only with the account's key", async () => {
    const { provider, deploymentKeys } = started();
    const answer = await understand(provider, accountKeys({ openrouter: "acct-or" }));
    expect(answer.upstream).toBe("openrouter");
    expect(fakes.google.seen).toHaveLength(0);
    expect(auths(fakes.openrouter)).toEqual(["Bearer acct-or"]);
    expect(deploymentKeys).not.toHaveBeenCalled();
  });

  it("judge: asks the decisions endpoint with the account's key, and marks its cost as the account's", async () => {
    const { provider, deploymentKeys } = started();
    fakes.openrouter.answer(({ path }) => (path === "/api/alpha/decisions" ? { status: 200, body: { likely: { p: 0.7 }, usage: { cost: 0.002 } } } : undefined));
    const request = { state: { a: 1 }, questions: { likely: { kind: "probability" } }, budgetMs: 5_000 };
    const answer = await (provider.llm.judge as (...args: unknown[]) => ReturnType<Provider["llm"]["judge"]>)(request, DEFAULT, accountKeys({ openrouter: "acct-or" }));
    expect(answer.status).toBe(200);
    expect("cost" in answer ? answer.cost : null).toEqual(expect.objectContaining({ state: "known", payer: "account" }));
    expect(auths(fakes.openrouter)).toEqual(["Bearer acct-or"]);
    expect(deploymentKeys).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid", 401, { error: { message: "No auth credentials found" } }],
    ["no_balance", 402, { error: { message: "Insufficient credits" } }],
    ["no_balance", 403, { error: { message: "Budget limit exceeded", metadata: { limit_source: "openrouter_workspace_budget" } } }],
    ["rate_limited", 429, { error: { message: "slow down" } }],
  ] as const)("judge: a refusal of the account's key as %s is the account's key failure, naming the upstream", async (reason, status, body) => {
    const { provider } = started();
    fakes.openrouter.answer(({ path }) => (path === "/api/alpha/decisions" ? { status, body } : undefined));
    const request = { state: { a: 1 }, questions: { likely: { kind: "probability" } }, budgetMs: 5_000 };
    const asked = (provider.llm.judge as (...args: unknown[]) => ReturnType<Provider["llm"]["judge"]>)(request, DEFAULT, accountKeys({ openrouter: "acct-or" }));
    await expect(asked).rejects.toMatchObject({ kind: "account_key_failed", upstream: "openrouter", reason });
  });

  it("judge: an upstream error on the account's key stays the answer's status, as on ours", async () => {
    const { provider } = started();
    fakes.openrouter.answer(({ path }) => (path === "/api/alpha/decisions" ? { status: 500, body: { error: { message: "boom" } } } : undefined));
    const request = { state: { a: 1 }, questions: { likely: { kind: "probability" } }, budgetMs: 5_000 };
    const answer = await (provider.llm.judge as (...args: unknown[]) => ReturnType<Provider["llm"]["judge"]>)(request, DEFAULT, accountKeys({ openrouter: "acct-or" }));
    expect(answer.status).toBe(500);
  });

  it("availability: counts only the set's upstreams as configured", () => {
    const { provider, deploymentKeys } = started();
    const availability = (provider.llm.availability as (...args: unknown[]) => ReturnType<Provider["llm"]["availability"]>)("deepseek/deepseek-v4-pro", "call", accountKeys({ openrouter: "acct-or" }));
    expect(availability.upstreams.map(({ upstream, configured }) => ({ upstream, configured }))).toEqual([
      { upstream: "deepseek", configured: false },
      { upstream: "openrouter", configured: true },
    ]);
    expect(deploymentKeys).not.toHaveBeenCalled();
  });

  it("fails with account_key_missing when the set has no key for any upstream of the route", async () => {
    const { provider, deploymentKeys } = started();
    const outcome = await settled(chat(provider, accountKeys({ wavespeed: "acct-ws" })));
    expect("error" in outcome ? keyFailureOf(outcome.error) : undefined).toMatchObject({ kind: "account_key_missing" });
    expect([...othersSeen(), ...fakes.openrouter.seen]).toHaveLength(0);
    expect(deploymentKeys).not.toHaveBeenCalled();
  });
});

describe("a failure of an account's OpenRouter key (critical path)", () => {
  const lasting = [
    { name: "402", status: 402, body: { error: { message: "Insufficient credits", code: 402 } }, reason: "no_balance" },
    {
      name: "spent key limit",
      status: 403,
      body: { error: { message: "Key limit exceeded", code: 403, metadata: { limit_source: "openrouter_key_limit", scope: "key_limit" } } },
      reason: "no_balance",
    },
    { name: "401", status: 401, body: { error: { message: "No auth credentials found", code: 401 } }, reason: "invalid" },
    { name: "missing model", status: 400, body: { error: { message: "deepseek/deepseek-v4-pro is not a valid model ID", code: 400 } }, reason: "model_not_found" },
  ];

  it.each(lasting)("fails a $name as account_key_failed/$reason, once, and never on DeepSeek or the deployment's key", async ({ status, body, reason }) => {
    const { provider, deploymentKeys } = started();
    fakes.openrouter.answer(() => ({ status, body }));
    const outcome = await settled(chat(provider, accountKeys({ openrouter: "acct-or" })));
    expect("error" in outcome ? keyFailureOf(outcome.error) : undefined).toMatchObject({ kind: "account_key_failed", reason, upstream: "openrouter" });
    expect(auths(fakes.openrouter)).toEqual(["Bearer acct-or"]);
    expect(othersSeen()).toHaveLength(0);
    expect(deploymentKeys).not.toHaveBeenCalled();
  });

  it("fails an understand call on a 402 as account_key_failed/no_balance, never on Google", async () => {
    const { provider } = started();
    fakes.openrouter.answer(() => ({ status: 402, body: { error: { message: "Insufficient credits", code: 402 } } }));
    const outcome = await settled(understand(provider, accountKeys({ openrouter: "acct-or" })));
    expect("error" in outcome ? keyFailureOf(outcome.error) : undefined).toMatchObject({ kind: "account_key_failed", reason: "no_balance" });
    expect(fakes.google.seen).toHaveLength(0);
  });

  it.each([
    { name: "429", status: 429, kind: "account_key_failed", reason: "rate_limited" },
    { name: "503", status: 503, kind: "upstream_unavailable", reason: undefined },
  ])("retries a $name on the same key, then fails it as $kind", async ({ status, kind, reason }) => {
    const { provider, deploymentKeys } = started(2);
    fakes.openrouter.answer(() => ({ status, body: { error: { message: "busy", code: status } } }));
    const outcome = await settled(chat(provider, accountKeys({ openrouter: "acct-or" })));
    expect("error" in outcome ? keyFailureOf(outcome.error) : undefined).toMatchObject({ kind, ...(reason === undefined ? {} : { reason }), upstream: "openrouter" });
    // The first try and both retries, all on the account's key.
    expect(auths(fakes.openrouter)).toEqual(["Bearer acct-or", "Bearer acct-or", "Bearer acct-or"]);
    expect(othersSeen()).toHaveLength(0);
    expect(deploymentKeys).not.toHaveBeenCalled();
  });
});

describe("an account's pending cost", () => {
  it("is looked up only with the keys of the owner that ran the call, and then with the account's key", async () => {
    const { provider, deploymentKeys } = started();
    const { cost: _cost, ...withoutCost } = CHAT_REPLY.usage;
    fakes.openrouter.answer(({ path }) => {
      if (path === "/api/v1/generation") return { status: 200, body: { data: { id: "gen-test", total_cost: 0.0007, native_tokens_prompt: 11, native_tokens_completion: 3 } } };
      return { status: 200, body: { ...CHAT_REPLY, usage: withoutCost } };
    });
    const keys = accountKeys({ openrouter: "acct-or" });
    const answer = await understand(provider, keys);
    const pending = answer.costs.find((c): c is Extract<Cost, { state: "pending" }> => c.state === "pending");
    expect(pending).toBeDefined();
    const lookup = JSON.parse(JSON.stringify(pending!.lookup)) as Extract<Cost, { state: "pending" }>["lookup"];
    // Asked on the deployment's keys (none passed), the account's generation is refused before anything is sent.
    await expect(provider.cost.lookup(lookup, { lastAttempt: false })).rejects.toThrow();
    expect(fakes.openrouter.seen.filter((s) => s.path === "/api/v1/generation")).toHaveLength(0);
    const cost = await provider.cost.lookup(lookup, { lastAttempt: false, keys });
    expect(cost).toMatchObject({ state: "known", payer: "account" });
    expect(fakes.openrouter.seen.filter((s) => s.path === "/api/v1/generation").map((s) => s.authorization)).toEqual(["Bearer acct-or"]);
    expect(deploymentKeys).not.toHaveBeenCalled();
  });
});

describe("the LLM client cache", () => {
  it("builds an account's client for each call and keeps none, so a replaced key leaves nothing in the process", async () => {
    const { provider } = started();
    const build = vi.spyOn(openrouter, "build");
    await chat(provider, accountKeys({ openrouter: "acct-a" }));
    await chat(provider, accountKeys({ openrouter: "acct-b" }));
    await chat(provider, accountKeys({ openrouter: "acct-a" }));
    expect(build.mock.calls.map(([, key]) => key)).toEqual(["acct-a", "acct-b", "acct-a"]);
    expect(auths(fakes.openrouter)).toEqual(["Bearer acct-a", "Bearer acct-b", "Bearer acct-a"]);
  });

  it("builds the deployment's client once and reuses it", async () => {
    const { provider } = started();
    const build = vi.spyOn(openrouter, "build");
    await chat(provider, undefined, "some/model");
    await chat(provider, undefined, "some/model");
    expect(build.mock.calls.map(([, key]) => key)).toEqual(["dep-or"]);
  });

  it("keeps the deployment's client apart from an account's on the same upstream", async () => {
    const { provider } = started();
    await chat(provider, undefined, "some/model");
    await chat(provider, accountKeys({ openrouter: "acct-a" }), "some/model");
    expect(auths(fakes.openrouter)).toEqual(["Bearer dep-or", "Bearer acct-a"]);
  });
});

describe("a malformed account key", () => {
  it("property: is refused with an error that never holds it, and nothing is sent", async () => {
    await fc.assert(
      fc.asyncProperty(malformedKeyArb, async (key) => {
        const { provider, deploymentKeys } = started(0);
        fakes.openrouter.seen.length = 0;
        const outcome = await settled(chat(provider, accountKeys({ openrouter: key })));
        expect("error" in outcome).toBe(true);
        expect(textOf((outcome as { error: unknown }).error).includes(key)).toBe(false);
        expect(posted(fakes.openrouter)).toHaveLength(0);
        expect(deploymentKeys).not.toHaveBeenCalled();
      }),
      { numRuns: 40 },
    );
  });
});
