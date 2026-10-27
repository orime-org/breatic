// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createProvider } from "../../provider.js";
import { assertBindsCatalog, parseProviderConfig } from "../schema.js";
import { catalog, ROOT, shipped, yaml } from "./shipped.js";

describe("the shipped provider configuration (design 4.1)", () => {
  it("loads, and binds every catalog model and param", () => {
    const config = parseProviderConfig(shipped());
    expect(() => assertBindsCatalog(config, catalog())).not.toThrow();
  });

  it("puts every catalog model on WaveSpeed at weight 1", () => {
    const { models } = parseProviderConfig(shipped());
    const off = Object.entries(models).filter(([, bindings]) => bindings.find((b) => b.upstream === "wavespeed")?.weight !== 1);
    expect(off.map(([name]) => name)).toEqual([]);
  });

  it("reaches each vendor at the address its SDK answers on", () => {
    const { upstreams } = shipped();
    expect(upstreams.deepseek?.base_url).toBe("https://api.deepseek.com");
    expect(upstreams.openrouter?.base_url).toBe("https://openrouter.ai/api/v1");
    expect(upstreams.wavespeed?.base_url).toBe("https://api.wavespeed.ai/api/v3");
  });

  it("routes each direct vendor first and OpenRouter after it, and reads understanding through Google first, OpenRouter after it (DD 26)", () => {
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

  it("ships the deployment override only as a template", () => {
    expect(existsSync(resolve(ROOT, "config/provider/routing.yaml.template"))).toBe(true);
    expect(() => parseProviderConfig({ ...shipped(), routing: yaml("provider/routing.yaml.template") ?? undefined })).not.toThrow();
  });
});
