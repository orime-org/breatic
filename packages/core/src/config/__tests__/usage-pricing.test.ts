// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, it, expect } from "vitest";

import { getUsagePricing, parseUsagePricing } from "@core/config/usage-pricing.js";

describe("usage pricing", () => {
  it("reads the deployed table: Brave per request", () => {
    const pricing = getUsagePricing();
    expect(pricing.services.brave_web_search.per_request).toBe(0.005);
    expect(pricing.services.brave_image_search.per_request).toBe(0.005);
  });

  it("refuses a negative price", () => {
    expect(() =>
      parseUsagePricing({
        services: {
          brave_web_search: { per_request: -0.005 },
          brave_image_search: { per_request: 0.005 },
        },
      }),
    ).toThrow();
  });

  it("refuses a table missing one of the Brave services", () => {
    expect(() =>
      parseUsagePricing({ services: { brave_web_search: { per_request: 0.005 } } }),
    ).toThrow();
  });
});
