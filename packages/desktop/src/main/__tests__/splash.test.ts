// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The splash a build shows at launch (#1599, design §5.2): the brand's logo
 * and name, and on a partner's brand the "powered by Breatic" line. It stays
 * at least a second so the attribution can be read, longer while the server
 * is still loading.
 */

import { describe, it, expect } from "vitest";

import { SPLASH_MIN_MS, splashCloseDelay, splashQuery } from "@desktop/main/splash.js";

describe("splashCloseDelay", () => {
  it("waits out the rest of the minimum when the server loads quickly", () => {
    expect(splashCloseDelay(1_000, 1_300)).toBe(SPLASH_MIN_MS - 300);
  });

  it("closes at once when the splash has shown long enough", () => {
    expect(splashCloseDelay(1_000, 1_000 + SPLASH_MIN_MS)).toBe(0);
    expect(splashCloseDelay(1_000, 9_000)).toBe(0);
  });

  it("is at least a second", () => {
    expect(SPLASH_MIN_MS).toBeGreaterThanOrEqual(1_000);
  });
});

describe("splashQuery", () => {
  it("names a partner's product and asks for the attribution line", () => {
    expect(splashQuery({ productName: "Acme Studio", poweredBy: true, splashLogo: "logo.svg" })).toEqual({ product: "Acme Studio", poweredBy: "1", logo: "logo.svg" });
  });

  it("leaves the attribution off the official build", () => {
    expect(splashQuery({ productName: "breatic", poweredBy: false, splashLogo: "logo.svg" }).poweredBy).toBe("0");
  });
});
