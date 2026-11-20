// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import type { MediaBinding, ProviderConfigInput } from "../config/schema.js";
import type { KeySet } from "../index.js";
import type { Availability, EstimateInput } from "../pricing/estimate.js";
import { createProvider, type Provider } from "../provider.js";
import { accountKeys, deploymentKeyOf } from "./keys-harness.js";

// Availability, estimate and refusal on the key set the caller hands each call (inner#1953): on an account's keys only
// the upstreams it filled count as configured, and the deployment's keys are never read.

/**
 * Model `m` on WaveSpeed (weight 1, durations 5 and 10) and fal (weight 2, duration 5 only), each at a flat price.
 * @returns The raw configuration.
 */
function config(): ProviderConfigInput {
  const binding = (upstream: string, weight: number, durations: number[], price: number): MediaBinding => ({
    upstream,
    weight,
    model_id: "m",
    prompt_field: "prompt",
    params: { duration: { field: "duration", supported: durations } },
    ...(upstream === "fal" ? { output_field: "video" } : {}),
    pricing: { kind: "formula", base_price: price, formula: "", discount_rate: 100 },
  });
  return {
    upstreams: {
      wavespeed: { kind: "wavespeed", base_url: "http://127.0.0.1:9", key_env: "WAVESPEED_API_KEY" },
      fal: { kind: "fal", base_url: "http://127.0.0.1:9", billing_url: "http://127.0.0.1:9/v1", key_env: "FAL_KEY" },
    },
    media: { models: { m: { upstreams: [binding("wavespeed", 1, [5, 10], 100), binding("fal", 2, [5], 200)] } } },
  };
}

/**
 * A provider whose deployment holds both keys, read through a spy.
 * @returns The provider and the spy, cleared of whatever building it read.
 */
function started(): { provider: Provider; deploymentKeys: ReturnType<typeof deploymentKeyOf> } {
  const deploymentKeys = deploymentKeyOf({ WAVESPEED_API_KEY: "dep-ws", FAL_KEY: "dep-fal" });
  const provider = createProvider({ config: config(), keyOf: deploymentKeys, llmMaxRetries: 0, cleanText: (t) => t });
  deploymentKeys.mockClear();
  return { provider, deploymentKeys };
}

const run = (duration: number): EstimateInput => ({ prompt: "a fox", params: { duration }, durations: {}, placeholders: [], durationsMissing: [] });
const DEFAULT = { mode: "default" } as const;
const FAL_ONLY: KeySet = accountKeys({ fal: "acct-fal" });

type WithKeys = {
  availability(model: string, keys?: KeySet): Availability;
  estimate(model: string, input: EstimateInput, route: typeof DEFAULT, keys?: KeySet): ReturnType<Provider["estimate"]>;
  refusal(model: string, input: EstimateInput, route: typeof DEFAULT, keys?: KeySet): ReturnType<Provider["refusal"]>;
};

describe("availability on a key set", () => {
  it("counts only the upstreams an account filled as configured, reading no deployment key", () => {
    const { provider, deploymentKeys } = started();
    const read = (provider as unknown as WithKeys).availability("m", FAL_ONLY);
    expect(read.upstreams.map(({ upstream, configured }) => ({ upstream, configured }))).toEqual([
      { upstream: "wavespeed", configured: false },
      { upstream: "fal", configured: true },
    ]);
    expect(deploymentKeys).not.toHaveBeenCalled();
  });

  it("counts none as configured for an account that filled none of the model's upstreams", () => {
    const { provider, deploymentKeys } = started();
    const read = (provider as unknown as WithKeys).availability("m", accountKeys({ openrouter: "acct-or" }));
    expect(read.upstreams.every((u) => !u.configured)).toBe(true);
    expect(deploymentKeys).not.toHaveBeenCalled();
  });
});

describe("estimate and refusal on a key set", () => {
  it("prices the run on the account's upstream, not the deployment's first", async () => {
    const { provider, deploymentKeys } = started();
    const estimate = await (provider as unknown as WithKeys).estimate("m", run(5), DEFAULT, FAL_ONLY);
    expect(estimate?.upstream).toBe("fal");
    expect(deploymentKeys).not.toHaveBeenCalled();
  });

  it("estimates nothing when the account filled no upstream of the model", async () => {
    const { provider } = started();
    expect(await (provider as unknown as WithKeys).estimate("m", run(5), DEFAULT, accountKeys({}))).toBeNull();
  });

  it("refuses an input only the deployment's upstream could take", async () => {
    const { provider, deploymentKeys } = started();
    // WaveSpeed takes 10 s and the deployment has its key, but the account filled only fal, which takes 5 s.
    expect(await provider.refusal("m", run(10), DEFAULT)).toBeNull();
    deploymentKeys.mockClear();
    expect(await (provider as unknown as WithKeys).refusal("m", run(10), DEFAULT, FAL_ONLY)).not.toBeNull();
    expect(deploymentKeys).not.toHaveBeenCalled();
  });
});

describe("keyScope", () => {
  it("tells two keys on one upstream apart, keeps one key the same, and never holds the key", async () => {
    const { keyScope } = await import("../keys.js");
    expect(keyScope("openrouter", "sk-a")).toBe(keyScope("openrouter", "sk-a"));
    expect(keyScope("openrouter", "sk-a")).not.toBe(keyScope("openrouter", "sk-b"));
    expect(keyScope("openrouter", "sk-a")).not.toBe(keyScope("fal", "sk-a"));
    expect(keyScope("openrouter", "sk-a")).not.toContain("sk-a");
  });
});
