// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from "vitest";

import { getUsagePricing, parseUsagePricing } from "@core/config/usage-pricing.js";

describe("usage pricing", () => {
  it("reads the deployed table: DeepSeek at its peak price, Brave per request", () => {
    const pricing = getUsagePricing();
    expect(pricing.models["deepseek/deepseek-v4-pro"]).toEqual({
      input_cache_hit_per_mtok: 0.044,
      input_cache_miss_per_mtok: 1.32,
      output_per_mtok: 3.96,
    });
    expect(pricing.services.brave_web_search.per_request).toBe(0.005);
    expect(pricing.services.brave_image_search.per_request).toBe(0.005);
  });

  it("refuses a negative price", () => {
    expect(() =>
      parseUsagePricing({
        models: {
          "x/y": { input_cache_hit_per_mtok: 0, input_cache_miss_per_mtok: -1, output_per_mtok: 1 },
        },
        services: {
          brave_web_search: { per_request: 0.005 },
          brave_image_search: { per_request: 0.005 },
        },
      }),
    ).toThrow();
  });

  it("refuses a table missing one of the Brave services", () => {
    expect(() =>
      parseUsagePricing({ models: {}, services: { brave_web_search: { per_request: 0.005 } } }),
    ).toThrow();
  });
});
