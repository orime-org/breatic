// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { OFF_WAVESPEED } from "../../media/wavespeed/__tests__/departures.js";
import { createProvider } from "../../provider.js";
import { assess } from "../../pricing/estimate.js";
import { assertBindsCatalog, parseProviderConfig } from "../schema.js";
import { catalog, ROOT, shipped, yaml } from "./shipped.js";

describe("the shipped provider configuration", () => {
  it("loads, and binds every catalog model and param", () => {
    const config = parseProviderConfig(shipped());
    expect(() => assertBindsCatalog(config, catalog())).not.toThrow();
  });

  it("puts every catalog model WaveSpeed still serves on WaveSpeed at weight 1", () => {
    const { models } = parseProviderConfig(shipped());
    const off = Object.entries(models).filter(([name, bindings]) => !OFF_WAVESPEED.has(name) && bindings.find((b) => b.upstream === "wavespeed")?.weight !== 1);
    expect(off.map(([name]) => name)).toEqual([]);
  });

  it("reaches each vendor at the address its SDK answers on", () => {
    const { upstreams } = shipped();
    expect(upstreams.deepseek?.base_url).toBe("https://api.deepseek.com");
    expect(upstreams.openrouter?.base_url).toBe("https://openrouter.ai/api/v1");
    expect(upstreams.wavespeed?.base_url).toBe("https://api.wavespeed.ai/api/v3");
  });

  // Today's DIRECT_ROUTES (domain/src/agent/llm.ts at ce553bb38): prefix, vendor and the key it authenticates with.
  it.each([
    ["anthropic/", "anthropic", "ANTHROPIC_API_KEY"],
    ["google/", "google", "GOOGLE_API_KEY"],
    ["openai/", "openai", "OPENAI_API_KEY"],
    ["deepseek/", "deepseek", "DEEPSEEK_API_KEY"],
  ])("sends %s models straight to %s when %s is set, as today's DIRECT_ROUTES does (acceptance 6)", (prefix, kind, key) => {
    const provider = createProvider({ config: shipped(), keyOf: (name) => (name === key ? "k" : undefined), llmMaxRetries: 0, cleanText: (t) => t });
    const [first] = provider.llm.availability(`${prefix}some-model`, "call").upstreams;
    expect(first).toMatchObject({ configured: true, envVar: key });
    expect(parseProviderConfig(shipped()).upstreams[first!.upstream]?.kind).toBe(kind);
    // The upstream name is what the call is charged under (agent_usage_records.provider), as today's route name.
    expect(first!.upstream).toBe(kind);
  });

  it("sends any other model to OpenRouter on OPENROUTER_API_KEY, as today's FALLBACK_ROUTE does (acceptance 6)", () => {
    const provider = createProvider({ config: shipped(), keyOf: (name) => (name === "OPENROUTER_API_KEY" ? "k" : undefined), llmMaxRetries: 0, cleanText: (t) => t });
    const upstreams = provider.llm.availability("meta/llama-x", "call").upstreams;
    expect(upstreams).toEqual([expect.objectContaining({ configured: true, envVar: "OPENROUTER_API_KEY" })]);
    expect(parseProviderConfig(shipped()).upstreams[upstreams[0]!.upstream]?.kind).toBe("openrouter");
    expect(upstreams[0]!.upstream).toBe("openrouter");
  });

  it("asks DeepSeek for Flash 1017 as deepseek-flash, as today's vendorId does (acceptance 6)", () => {
    expect(shipped().llm?.vendor_ids?.["deepseek/deepseek-v4.1-flash-1017"]).toEqual({ deepseek: "deepseek-flash" });
  });

  it("routes each direct vendor first and OpenRouter after it, and reads understanding through Google first, OpenRouter after it", () => {
    const { llm } = shipped();
    for (const prefix of ["anthropic/", "deepseek/", "google/", "openai/"]) {
      const route = llm?.routes.find((r) => r.prefix === prefix);
      expect(route?.upstreams.find((u) => u.upstream === "openrouter")?.weight).toBe(1);
      expect(route?.upstreams.find((u) => u.upstream !== "openrouter")?.weight).toBe(0);
    }
    expect(llm?.routes.at(-1)).toEqual({ prefix: "", upstreams: [{ upstream: "openrouter", weight: 0 }] });
    expect(llm?.understand_routes?.find((r) => r.prefix === "google/")?.upstreams).toEqual([{ upstream: "google", weight: 0 }, { upstream: "openrouter", weight: 1 }]);
  });

  it("prices every model a full deployment reaches directly: the agent's and the element descriptions'", () => {
    const keys = Object.fromEntries(Object.values(shipped().upstreams).map((u) => [u.key_env, "k"]));
    const provider = createProvider({ config: shipped(), keyOf: (name) => keys[name], llmMaxRetries: 0, cleanText: (t) => t });
    const agent = yaml<{ default_model: string; consolidation_model: string }>("agent.yaml");
    const describers = Object.values(parseProviderConfig(shipped()).models)
      .flat()
      .flatMap((b) => b.extra_steps ?? [])
      .flatMap((step) => (step.describe === undefined ? [] : [step.describe.model]));
    expect(describers.length).toBeGreaterThan(0);
    expect(() => provider.llm.assertModelsPriced([agent.default_model, agent.consolidation_model, ...describers])).not.toThrow();
  });

  it("states OpenRouter's unit price beside each direct price, for cheapest calls to rank both", () => {
    const llm = shipped().llm!;
    const missing = Object.keys(llm.prices ?? {}).filter((model) => llm.openrouter_prices?.[model] === undefined);
    expect(missing).toEqual([]);
  });

  it("declares every catalog extra step on WaveSpeed as the catalog does, its optional flag included", () => {
    interface CatalogStep { endpoint: string; at: string; for_param?: string; per_item?: boolean; optional?: boolean; pricing: { base_price: number; formula: string; discount_rate: number } }
    const files = ["image", "video", "audio", "tts", "three_d"].map((m) => `models/${m}/models.yaml`);
    const { models } = parseProviderConfig(shipped());
    for (const file of files) {
      for (const model of yaml<{ models: { name: string; extra_steps?: CatalogStep[] }[] }>(file).models) {
        const declared = models[model.name]?.find((b) => b.upstream === "wavespeed")?.extra_steps ?? [];
        const seen = declared.map((s) => ({ endpoint: s.endpoint, at: s.at, for_param: s.for_param, per_item: s.per_item, optional: s.optional, pricing: s.pricing }));
        const wanted = (model.extra_steps ?? []).map((s) => ({
          endpoint: s.endpoint,
          at: s.at,
          for_param: s.for_param,
          per_item: s.per_item,
          optional: s.optional,
          pricing: { kind: "formula", ...s.pricing },
        }));
        expect(seen, model.name).toEqual(wanted);
      }
    }
  });

  describe("the optional rig after a Tripo H3.1 generation (inner#1692)", () => {
    const TRIPO = ["tripo-h3.1-t23d", "tripo-h3.1-i23d", "tripo-h3.1-multiview"];

    it.each(TRIPO)("%s rigs on rig_skeleton as an optional step priced per run", (model) => {
      const binding = parseProviderConfig(shipped()).models[model]?.find((b) => b.upstream === "wavespeed");
      expect(binding?.extra_steps).toEqual([{
        kind: "rig",
        endpoint: "tripo3d/rig",
        at: "after",
        for_param: "rig_skeleton",
        optional: true,
        pricing: { kind: "formula", base_price: 300000, formula: "", discount_rate: 100 },
      }]);
    });

    it.each(TRIPO)("%s never sends rig_skeleton to the generation: no field binds it", (model) => {
      const binding = parseProviderConfig(shipped()).models[model]?.find((b) => b.upstream === "wavespeed");
      expect(binding?.params).toBeDefined();
      expect(Object.keys(binding?.params ?? {})).not.toContain("rig_skeleton");
    });

    it("binds no field to a param that switches on a step after the model's own call, on any model", () => {
      const leaked = Object.entries(parseProviderConfig(shipped()).models).flatMap(([model, bindings]) =>
        bindings.flatMap((b) => (b.extra_steps ?? [])
          .filter((s) => s.at === "after" && s.for_param !== undefined && b.params?.[s.for_param] !== undefined)
          .map((s) => `${model}.${s.for_param!}`)));
      expect(leaked).toEqual([]);
    });

    it.each(TRIPO)("%s takes a run asking for a skeleton only on WaveSpeed, the one upstream that rigs", async (model) => {
      const provider = createProvider({ config: shipped(), keyOf: () => "k", llmMaxRetries: 0, cleanText: (t) => t });
      const rules = provider.pricingRules(model);
      const run = (rig: boolean) => ({ params: { rig_skeleton: rig }, prompt: "a knight", durations: {}, placeholders: [], durationsMissing: [] });
      for (const upstream of ["fal", "sandbase"]) {
        expect(await assess(rules, upstream, run(true)), upstream).toHaveProperty("rejected");
        expect(await assess(rules, upstream, run(false)), upstream).toHaveProperty("estimate");
      }
      expect(await assess(rules, "wavespeed", run(true))).toHaveProperty("estimate");
    });

    it.each(TRIPO)("%s estimates the rig only when rig_skeleton is on", async (model) => {
      const provider = createProvider({ config: shipped(), keyOf: (name) => (name === "WAVESPEED_API_KEY" ? "k" : undefined), llmMaxRetries: 0, cleanText: (t) => t });
      const at = (params: Record<string, unknown>): Promise<number | undefined> =>
        provider.estimate(model, { params, prompt: "a knight", durations: {}, placeholders: [], durationsMissing: [] }, { mode: "default" }).then((e) => e?.usd);
      const absent = await at({});
      const off = await at({ rig_skeleton: false });
      const on = await at({ rig_skeleton: true });
      expect(absent).toBeDefined();
      expect(off).toBeCloseTo(absent!, 9);
      expect(on! - absent!).toBeCloseTo(0.3, 9);
    });
  });

  it("ships the deployment override only as a template", () => {
    expect(existsSync(resolve(ROOT, "config/provider/routing.yaml.template"))).toBe(true);
    expect(() => parseProviderConfig({ ...shipped(), routing: yaml("provider/routing.yaml.template") ?? undefined })).not.toThrow();
  });
});
