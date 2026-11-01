// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import { assertBindsCatalog, parseProviderConfig, ProviderConfigError, type CatalogShape, type MediaBinding, type ProviderConfigInput } from "../schema.js";

const pricing = { kind: "formula", base_price: 100000, formula: "", discount_rate: 100 };

const upstreams = {
  wavespeed: { kind: "wavespeed", base_url: "https://api.wavespeed.ai/api/v3", key_env: "WAVESPEED_API_KEY" },
  fal: { kind: "fal", base_url: "https://queue.fal.run", key_env: "FAL_KEY" },
  sandbase: { kind: "sandbase", base_url: "https://api.sandbase.ai/v1", key_env: "SANDBASE_API_KEY" },
};

/**
 * A binding of the test model.
 * @param upstream - The upstream.
 * @param weight - Its weight.
 * @param extra - Fields to add.
 * @returns The binding.
 */
function bind(upstream: string, weight: number, extra: Record<string, unknown> = {}): MediaBinding {
  const output = upstream === "fal" ? { output_field: "video" } : {};
  return { upstream, weight, model_id: `${upstream}/m`, pricing, ...output, ...extra } as MediaBinding;
}

/**
 * The problems loading one model's bindings reports.
 * @param bindings - The bindings.
 * @returns The problem lines; empty when it loads.
 */
function loadProblems(bindings: MediaBinding[]): readonly string[] {
  const raw: ProviderConfigInput = { upstreams, media: { models: { m: { upstreams: bindings } } } };
  try {
    parseProviderConfig(raw);
    return [];
  } catch (error) {
    if (error instanceof ProviderConfigError) return error.problems;
    throw error;
  }
}

/**
 * The problems the catalog check reports for one model.
 * @param bindings - The bindings.
 * @param params - The catalog params of the model.
 * @returns The problem lines; empty when it passes.
 */
function catalogProblems(bindings: MediaBinding[], params: CatalogShape["models"][number]["params"]): readonly string[] {
  const config = parseProviderConfig({ upstreams, media: { models: { m: { upstreams: bindings } } } });
  try {
    assertBindsCatalog(config, { models: [{ name: "m", params }] });
    return [];
  } catch (error) {
    if (error instanceof ProviderConfigError) return error.problems;
    throw error;
  }
}

describe("reseller bindings load", () => {
  it("loads fal and SandBase bindings that use fixed, drops, supported, as, item_fields and dotted fields", () => {
    expect(loadProblems([
      bind("wavespeed", 1, { params: { duration: { field: "duration" } } }),
      bind("fal", 2, {
        fixed: { task: "extension" },
        params: {
          duration: { field: "duration", as: "string", supported: [5, 10] },
          voice: { field: "voice_setting.voice_id" },
          shots: { field: "multi_prompt", item_fields: { prompt: { field: "prompt" } } },
        },
        drops: { seed: { all_values: "fal derives its own seed; results differ only by sampling" }, web: [false] },
      }),
      bind("sandbase", 3, { fixed: { mode: "async" }, params: { duration: { field: "duration" } } }),
    ])).toEqual([]);
  });

  it("refuses a fal binding without output_field, naming model and upstream", () => {
    const { output_field: _omitted, ...withoutOutput } = bind("fal", 2);
    expect(loadProblems([withoutOutput as MediaBinding])).toEqual([expect.stringMatching(/m.*fal.*output_field/)]);
  });

  it("refuses output_field on a binding to an upstream that is not fal", () => {
    expect(loadProblems([bind("sandbase", 3, { output_field: "video" })])).toEqual([expect.stringMatching(/m.*sandbase.*output_field/)]);
  });

  it("refuses a fixed field that a param or the prompt also writes, or that is a prefix of a dotted param field", () => {
    expect(loadProblems([bind("fal", 2, { fixed: { duration: "5" }, params: { duration: { field: "duration" } } })])).toEqual([
      expect.stringMatching(/m.*fal.*duration/),
    ]);
    expect(loadProblems([bind("fal", 2, { fixed: { prompt: "x" }, prompt_field: "prompt" })])).toEqual([expect.stringMatching(/m.*fal.*prompt/)]);
    expect(loadProblems([bind("fal", 2, { fixed: { voice_setting: { speed: 1 } }, params: { voice: { field: "voice_setting.voice_id" } } })])).toEqual([
      expect.stringMatching(/m.*fal.*voice_setting/),
    ]);
  });

  it("still loads two params that write one field, as the kling shot_type and auto_shots bindings do", () => {
    expect(loadProblems([bind("wavespeed", 1, { params: { shot_type: { field: "shot_type" }, auto_shots: { field: "shot_type", values: { true: "intelligence" }, absent_value: false } } })])).toEqual([]);
  });

  it("refuses a pricing formula that reads a dotted field", () => {
    const formula = '{"total_price": base_price * voice_setting.speed}';
    expect(loadProblems([bind("fal", 2, { params: { speed: { field: "voice_setting.speed" } }, pricing: { ...pricing, formula } })])).toEqual([
      expect.stringMatching(/m.*fal.*voice_setting\.speed/),
    ]);
  });

  it("refuses an unknown as and a drops entry of the wrong shape", () => {
    expect(loadProblems([bind("fal", 2, { params: { d: { field: "d", as: "boolean" } } })])).toHaveLength(1);
    expect(loadProblems([bind("fal", 2, { drops: { seed: { all_values: "" } } })])).toHaveLength(1);
  });

  it("refuses a reseller drops wildcard on a param the WaveSpeed binding sends, naming model, upstream and param", () => {
    expect(loadProblems([
      bind("wavespeed", 1, { params: { seed: { field: "seed" } } }),
      bind("fal", 2, { drops: { seed: "*" } }),
    ])).toEqual([expect.stringMatching(/m.*fal.*seed/)]);
    expect(loadProblems([
      bind("wavespeed", 1, { drops: { seed: "*" } }),
      bind("fal", 2, { drops: { seed: "*" } }),
    ])).toEqual([]);
  });
});

describe("reseller bindings against the catalog", () => {
  const params: CatalogShape["models"][number]["params"] = {
    duration: { values: [5, 10, 15] },
    web: { values: [true, false] },
    seed: {},
    shots: { type: "items", fields: { prompt: { type: "text" }, duration: { values: [1, 2, 3] } } },
    voice_id: { remote_source: "voices" },
  };
  const everything = {
    params: { duration: { field: "duration" }, shots: { field: "multi_prompt", item_fields: { prompt: { field: "prompt" }, duration: { field: "duration" } } }, voice_id: { field: "voice" } },
    drops: { web: [false], seed: { all_values: "sampling only" } },
    voice_map: { Alicia: "alicia" },
  };

  it("passes a binding that puts every catalog param in params or drops and maps voices", () => {
    expect(catalogProblems([bind("fal", 2, everything)], params)).toEqual([]);
  });

  it("reports a catalog param a binding neither binds nor drops, and one it both binds and drops", () => {
    const missing = catalogProblems([bind("fal", 2, { ...everything, drops: { web: [false] } })], params);
    expect(missing).toEqual([expect.stringMatching(/m.*fal.*seed/)]);
    const both = catalogProblems([bind("fal", 2, { ...everything, drops: { ...everything.drops, duration: [5] } })], params);
    expect(both).toEqual([expect.stringMatching(/m.*fal.*duration/)]);
  });

  it("reports supported or drops values the param does not offer", () => {
    const found = catalogProblems([bind("fal", 2, {
      ...everything,
      params: { ...everything.params, duration: { field: "duration", supported: [5, 20] } },
      drops: { web: ["maybe"], seed: { all_values: "sampling only" } },
    })], params);
    expect(found).toHaveLength(2);
    expect(found.some((p) => p.includes("duration") && p.includes("20"))).toBe(true);
    expect(found.some((p) => p.includes("web") && p.includes("maybe"))).toBe(true);
  });

  it("reports item_fields on a param that is not a list of items, and a sub-field the catalog item does not have", () => {
    const found = catalogProblems([bind("fal", 2, {
      ...everything,
      params: {
        ...everything.params,
        duration: { field: "duration", item_fields: { x: { field: "x" } } },
        shots: { field: "multi_prompt", item_fields: { prompt: { field: "prompt" }, camera: { field: "camera" } } },
      },
    })], params);
    expect(found).toHaveLength(2);
    expect(found.some((p) => p.includes("duration") && p.includes("item_fields"))).toBe(true);
    expect(found.some((p) => p.includes("shots") && p.includes("camera"))).toBe(true);
  });

  it("reports a reseller binding of a voices param without a voice_map, and leaves the WaveSpeed binding alone", () => {
    const found = catalogProblems([
      bind("wavespeed", 1, { ...everything, voice_map: undefined }),
      bind("fal", 2, { ...everything, voice_map: undefined }),
    ], params);
    expect(found).toEqual([expect.stringMatching(/m.*fal.*voice_id/)]);
  });
});
