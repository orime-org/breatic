// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * How the deployment's `GOOGLE_ADS_CONVERSION_ACTIONS` is read (inner#2051).
 *
 * The collaboration conversion is gone. A deployment that still lists it, or
 * lists only some conversions, keeps uploading the ones it names; a key the
 * product does not know is reported for the entry to log, and a malformed value
 * still turns uploads off.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as AdsConversion from "../ads-conversion.js";

const { config } = vi.hoisted(() => ({
  config: { GOOGLE_ADS_CUSTOMER_ID: "", GOOGLE_ADS_CONVERSION_ACTIONS: "", GOOGLE_DATA_MANAGER_CREDENTIALS: "" },
}));
vi.mock("@core/config/env.js", () => ({
  env: config,
  MONOREPO_ROOT: decodeURIComponent(new URL("../../../../../", import.meta.url).pathname),
}));

const CREDENTIALS = JSON.stringify({ client_email: "uploader@example.test", private_key: "key" });

/**
 * Load the module fresh with the given actions, since it reads the configuration once.
 * @param actions - The raw `GOOGLE_ADS_CONVERSION_ACTIONS` value.
 * @returns The module.
 */
async function loadWith(actions: string): Promise<typeof AdsConversion> {
  config.GOOGLE_ADS_CUSTOMER_ID = "123-456-7890";
  config.GOOGLE_ADS_CONVERSION_ACTIONS = actions;
  config.GOOGLE_DATA_MANAGER_CREDENTIALS = CREDENTIALS;
  return import("../ads-conversion.js");
}

beforeEach(() => {
  vi.resetModules();
});

describe("ad conversion names", () => {
  it("no longer include the collaboration conversion", async () => {
    const { ADS_CONVERSIONS } = await import("../ads-types.js");
    expect([...ADS_CONVERSIONS]).toEqual(["signup", "first_project", "credit_purchase", "subscription"]);
  });
});

describe("GOOGLE_ADS_CONVERSION_ACTIONS", () => {
  it("keeps the known conversions on when the value still lists collaboration, and reports that key", async () => {
    const ads = await loadWith(JSON.stringify({
      signup: "1", first_project: "2", collaboration: "3", credit_purchase: "4", subscription: "5",
    }));
    expect(ads.adsConversionState()).toBe("on");
    expect(ads.adsConversionConfig()?.actions).toEqual({ signup: "1", first_project: "2", credit_purchase: "4", subscription: "5" });
    expect(ads.adsConversionIgnoredKeys()).toEqual(["collaboration"]);
  });

  it("is on when only some conversions are named", async () => {
    const ads = await loadWith(JSON.stringify({ signup: "1", credit_purchase: "4" }));
    expect(ads.adsConversionState()).toBe("on");
    expect(ads.adsConversionConfig()?.actions).toEqual({ signup: "1", credit_purchase: "4" });
    expect(ads.adsConversionIgnoredKeys()).toEqual([]);
  });

  it("is invalid when a known conversion's action id is not a number", async () => {
    const ads = await loadWith(JSON.stringify({ signup: "abc" }));
    expect(ads.adsConversionState()).toBe("invalid");
    expect(ads.adsConversionConfig()).toBeNull();
  });
});
