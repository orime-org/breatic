// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  assertBindsCatalog,
  candidatesOf,
  parseProviderConfig,
  ProviderConfigError,
  type MediaBinding,
  type ProviderConfigInput,
} from "../schema.js";

const pricing = { kind: "formula", base_price: 0.1, formula: "", discount_rate: 100 };

const upstreams = {
  bytedance: { kind: "bytedance", base_url: "https://ark.example", key_env: "BYTEPLUS_ARK_API_KEY" },
  wavespeed: { kind: "wavespeed", base_url: "https://api.wavespeed.ai/api/v3", key_env: "WAVESPEED_API_KEY" },
  fal: { kind: "fal", base_url: "https://queue.fal.run", key_env: "FAL_KEY" },
};

/**
 * A binding of `seedance` to one upstream.
 * @param upstream - The upstream.
 * @param weight - Its weight.
 * @param extra - Fields to override.
 * @returns The binding.
 */
function bind(upstream: string, weight: number, extra: Partial<MediaBinding> = {}): MediaBinding {
  return { upstream, weight, model_id: `${upstream}/seedance`, pricing, ...extra };
}

/**
 * A config with one model bound as given.
 * @param bindings - The model's bindings.
 * @param routing - The deployment's override file, if any.
 * @returns The raw input.
 */
function input(bindings: MediaBinding[], routing?: ProviderConfigInput["routing"]): ProviderConfigInput {
  return { upstreams, media: { models: { seedance: { upstreams: bindings } } }, ...(routing ? { routing } : {}) };
}

/**
 * The problems a config load reports.
 * @param raw - The raw input.
 * @returns The problem lines; empty when it loads.
 */
function problemsOf(raw: ProviderConfigInput): readonly string[] {
  try {
    parseProviderConfig(raw);
    return [];
  } catch (error) {
    if (error instanceof ProviderConfigError) return error.problems;
    throw error;
  }
}

describe("parseProviderConfig", () => {
  it("loads a valid configuration and keeps the default weights when no override file exists", () => {
    const config = parseProviderConfig(input([bind("bytedance", 0), bind("wavespeed", 1), bind("fal", 2)]));
    expect(config.models.seedance?.map((b) => [b.upstream, b.weight])).toEqual([["bytedance", 0], ["wavespeed", 1], ["fal", 2]]);
  });

  it("refuses two bindings of one model with the same weight, naming the model and the weight", () => {
    const problems = problemsOf(input([bind("wavespeed", 1), bind("fal", 1)]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("seedance");
    expect(problems[0]).toContain("1");
  });

  it("refuses a binding to an upstream that upstreams.yaml does not declare", () => {
    const problems = problemsOf(input([bind("replicate", 1)]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("seedance");
    expect(problems[0]).toContain("replicate");
  });

  it("refuses a binding without pricing", () => {
    const problems = problemsOf(input([{ upstream: "wavespeed", weight: 1, model_id: "x" } as MediaBinding]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("seedance");
    expect(problems[0]).toContain("wavespeed");
  });

  it("applies the deployment override to the weights", () => {
    const config = parseProviderConfig(input(
      [bind("bytedance", 0), bind("wavespeed", 1), bind("fal", 2)],
      { models: { seedance: { weights: { fal: 0, wavespeed: 1, bytedance: 2 } } } },
    ));
    const weights = Object.fromEntries((config.models.seedance ?? []).map((b) => [b.upstream, b.weight]));
    expect(weights).toEqual({ fal: 0, wavespeed: 1, bytedance: 2 });
  });

  it("refuses an override that makes two weights equal", () => {
    const problems = problemsOf(input(
      [bind("wavespeed", 1), bind("fal", 2)],
      { models: { seedance: { weights: { fal: 1 } } } },
    ));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("seedance");
  });

  it("refuses an override naming an upstream the model is not bound to", () => {
    const problems = problemsOf(input(
      [bind("wavespeed", 1)],
      { models: { seedance: { weights: { fal: 0 } } } },
    ));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("fal");
  });

  it("reports every problem at once", () => {
    const problems = problemsOf(input([bind("wavespeed", 1), bind("fal", 1), bind("replicate", 2)]));
    expect(problems).toHaveLength(2);
  });

  it("property: a load succeeds exactly when the effective weights of each model are unique", () => {
    fc.assert(fc.property(
      fc.array(fc.nat(3), { minLength: 3, maxLength: 3 }),
      fc.option(fc.array(fc.nat(3), { minLength: 3, maxLength: 3 }), { nil: undefined }),
      (base, override) => {
        const names = ["bytedance", "wavespeed", "fal"] as const;
        const raw = input(
          names.map((n, i) => bind(n, base[i]!)),
          override ? { models: { seedance: { weights: Object.fromEntries(names.map((n, i) => [n, override[i]!])) } } } : undefined,
        );
        const effective = override ?? base;
        const unique = new Set(effective).size === effective.length;
        expect(problemsOf(raw).length === 0).toBe(unique);
      },
    ));
  });
});

describe("candidatesOf", () => {
  it("marks each binding configured by whether its key env var has a value", () => {
    const config = parseProviderConfig(input([bind("bytedance", 0), bind("wavespeed", 1), bind("fal", 2)]));
    const env: Record<string, string> = { WAVESPEED_API_KEY: "k", FAL_KEY: "" };
    const candidates = candidatesOf(config, "seedance", (name) => env[name]);
    expect(candidates).toEqual([
      { upstream: "bytedance", weight: 0, configured: false, envVar: "BYTEPLUS_ARK_API_KEY" },
      { upstream: "wavespeed", weight: 1, configured: true, envVar: "WAVESPEED_API_KEY" },
      { upstream: "fal", weight: 2, configured: false, envVar: "FAL_KEY" },
    ]);
  });
});

describe("assertBindsCatalog", () => {
  const catalog = {
    models: [{ name: "seedance", params: { duration: { values: [5, 10] }, aspect_ratio: { values: ["16:9", "9:16"] } } }],
  };

  /**
   * The problems the catalog check reports for one model's bindings.
   * @param bindings - The bindings.
   * @param shape - The catalog.
   * @returns The problem lines; empty when it passes.
   */
  function catalogProblems(bindings: MediaBinding[], shape = catalog): readonly string[] {
    const config = parseProviderConfig(input(bindings));
    try {
      assertBindsCatalog(config, shape);
      return [];
    } catch (error) {
      if (error instanceof ProviderConfigError) return error.problems;
      throw error;
    }
  }

  it("passes a binding whose params and values all exist in the catalog", () => {
    expect(catalogProblems([bind("fal", 2, { params: { duration: { field: "duration", values: { "5": "5s", "10": "10s" } } } })])).toEqual([]);
  });

  it("reports a bound param that the model does not have", () => {
    const problems = catalogProblems([bind("fal", 2, { params: { resolution: { field: "resolution" } } })]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("resolution");
  });

  it("reports a value mapping for a value the param does not offer", () => {
    const problems = catalogProblems([bind("fal", 2, { params: { duration: { field: "duration", values: { "7": "7s" } } } })]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("7");
  });

  it("reports an absent_value the param does not offer", () => {
    const problems = catalogProblems([bind("fal", 2, { params: { aspect_ratio: { field: "aspect_ratio", absent_value: "1:1" } } })]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("1:1");
  });

  it("reports a catalog model that has no binding at all", () => {
    const problems = catalogProblems([bind("fal", 2)], { models: [...catalog.models, { name: "kling", params: {} }] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("kling");
  });
});
