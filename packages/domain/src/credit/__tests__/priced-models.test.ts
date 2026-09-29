// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from "vitest";

import { assertModelsPriced } from "@domain/credit/priced-models.js";

const PRICING = {
  models: {
    "deepseek/deepseek-v4-pro": {
      input_cache_hit_per_mtok: 0.044,
      input_cache_miss_per_mtok: 1.32,
      output_per_mtok: 3.96,
    },
  },
  services: {
    brave_web_search: { per_request: 0.005 },
    brave_image_search: { per_request: 0.005 },
  },
};

/**
 * Route by prefix, the way a deployment with a DeepSeek and a Google key does.
 * @param model - The model id.
 * @returns The provider that would serve it.
 */
function providerOf(model: string): string {
  if (model.startsWith("deepseek/")) return "deepseek";
  if (model.startsWith("google/")) return "google";
  return "openrouter";
}

describe("the startup price check", () => {
  it("passes when every directly reached model has a price", () => {
    expect(() =>
      assertModelsPriced(["deepseek/deepseek-v4-pro"], { pricing: PRICING, providerOf }),
    ).not.toThrow();
  });

  it("does not ask for a price for a model OpenRouter reports the cost of", () => {
    expect(() =>
      assertModelsPriced(["anthropic/claude-x"], { pricing: PRICING, providerOf }),
    ).not.toThrow();
  });

  it("names every directly reached model that has no price", () => {
    expect(() =>
      assertModelsPriced(["google/gemini-9", "deepseek/deepseek-v4-pro", "google/gemini-8"], {
        pricing: PRICING,
        providerOf,
      }),
    ).toThrow(/google\/gemini-9.*google\/gemini-8/);
  });
});
