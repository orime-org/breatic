// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the region settings in {@link parseConfig}: a deployment that sets
 * nothing is one region that also holds the global data, and a non-global
 * region must name where the global API lives.
 */

import { describe, it, expect } from "vitest";
import { parseConfig } from "@core/config/schema.js";

/**
 * Minimal valid raw env for {@link parseConfig}, overridable per case.
 * @param over - Fields to override on the base env map
 * @returns A raw env map with the required keys populated
 */
function baseEnv(over: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: "postgres://breatic:breatic@localhost:5432/breatic",
    YJS_DATABASE_URL: "postgres://breatic:breatic@localhost:5432/breatic_yjs",
    ...over,
  };
}

describe("parseConfig — regions", () => {
  it("treats a deployment that sets nothing as one region holding the global data", () => {
    const config = parseConfig(baseEnv());
    expect(config.REGION).toBe("default");
    expect(config.GLOBAL_REGION).toBe("default");
    expect(config.GLOBAL_API_URL).toBe("");
    expect(config.REGION_API_URLS).toEqual({});
  });

  it("defaults the global region to this region", () => {
    expect(parseConfig(baseEnv({ REGION: "us-west" })).GLOBAL_REGION).toBe("us-west");
  });

  it("parses the other regions' internal API addresses", () => {
    const config = parseConfig(
      baseEnv({
        REGION: "us-west",
        REGION_API_URLS: '{"sg":"http://10.1.0.5:3002"}',
        INTERNAL_API_SECRET: "secret",
        IDENTITY_SIGNING_KEY: "PEM",
        IDENTITY_SIGNING_KEY_ID: "k1",
        IDENTITY_COOKIE_DOMAIN: ".example.test",
      }),
    );
    expect(config.REGION_API_URLS).toEqual({ sg: "http://10.1.0.5:3002" });
  });

  it("refuses a non-global region without a global API address", () => {
    expect(() =>
      parseConfig(baseEnv({ REGION: "sg", GLOBAL_REGION: "us-west", IDENTITY_PUBLIC_KEYS: '{"k1":"PEM"}' })),
    ).toThrow(/GLOBAL_API_URL/);
  });

  it("accepts a non-global region that names the global API", () => {
    const config = parseConfig(
      baseEnv({
        REGION: "sg",
        GLOBAL_REGION: "us-west",
        GLOBAL_API_URL: "http://10.0.0.5:3002",
        IDENTITY_PUBLIC_KEYS: '{"k1":"PEM"}',
        INTERNAL_API_SECRET: "secret",
      }),
    );
    expect(config.REGION).toBe("sg");
    expect(config.GLOBAL_API_URL).toBe("http://10.0.0.5:3002");
  });

  // Payments are taken in the global region alone; a region holds credits
  // with PAYMENT_ENABLED and carries no Stripe secret (inner#1955).
  it("starts a non-global region with payments on and no Stripe secret, and still refuses the global one", () => {
    const region = { REGION: "sg", GLOBAL_REGION: "us-west", GLOBAL_API_URL: "http://10.0.0.5:3002", IDENTITY_PUBLIC_KEYS: '{"k1":"PEM"}', INTERNAL_API_SECRET: "secret" };
    expect(parseConfig(baseEnv({ ...region, PAYMENT_ENABLED: "true", STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "" })).PAYMENT_ENABLED).toBe(true);
    expect(() => parseConfig(baseEnv({ PAYMENT_ENABLED: "true", STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "" }))).toThrow(/STRIPE_SECRET_KEY/);
  });

  // A misconfigured second region must not start and answer every request
  // with 401 or a failed cross-region call (inner#1955).
  it("refuses a non-global region with no internal API secret to sign its calls with", () => {
    expect(() =>
      parseConfig(
        baseEnv({ REGION: "sg", GLOBAL_REGION: "us-west", GLOBAL_API_URL: "http://10.0.0.5:3002", IDENTITY_PUBLIC_KEYS: '{"k1":"PEM"}' }),
      ),
    ).toThrow(/INTERNAL_API_SECRET/);
  });

  it.each([
    ["INTERNAL_API_SECRET", { IDENTITY_SIGNING_KEY: "PEM", IDENTITY_SIGNING_KEY_ID: "k1" }],
    ["IDENTITY_SIGNING_KEY", { INTERNAL_API_SECRET: "secret" }],
  ])("refuses a global region with other regions and no %s", (missing, rest) => {
    expect(() =>
      parseConfig(baseEnv({ REGION: "us-west", REGION_API_URLS: '{"sg":"http://10.1.0.5:3002"}', ...rest })),
    ).toThrow(new RegExp(missing));
  });

  it("accepts regions on one host, whose cookie needs no parent domain", () => {
    const config = parseConfig(
      baseEnv({
        REGION: "us-west",
        REGION_API_URLS: '{"sg":"http://127.0.0.1:3362"}',
        INTERNAL_API_SECRET: "secret",
        IDENTITY_SIGNING_KEY: "PEM",
        IDENTITY_SIGNING_KEY_ID: "k1",
      }),
    );
    expect(config.IDENTITY_COOKIE_DOMAIN).toBe("");
  });

  it("refuses a region code with characters outside letters, digits and '-'", () => {
    expect(() => parseConfig(baseEnv({ REGION: "us west" }))).toThrow(/REGION/);
  });
});

describe("parseConfig — identity token keys", () => {
  it("signs nothing and holds no public keys when none are set", () => {
    const config = parseConfig(baseEnv());
    expect(config.IDENTITY_SIGNING_KEY).toBe("");
    expect(config.IDENTITY_SIGNING_KEY_ID).toBe("");
    expect(config.IDENTITY_PUBLIC_KEYS).toEqual({});
    expect(config.IDENTITY_COOKIE_DOMAIN).toBe("");
  });

  it("parses the public keys by kid", () => {
    const config = parseConfig(baseEnv({ IDENTITY_PUBLIC_KEYS: '{"k1":"PEM-ONE","k2":"PEM-TWO"}' }));
    expect(config.IDENTITY_PUBLIC_KEYS).toEqual({ k1: "PEM-ONE", k2: "PEM-TWO" });
  });

  it("refuses a signing key without the kid it signs under", () => {
    expect(() => parseConfig(baseEnv({ IDENTITY_SIGNING_KEY: "PEM" }))).toThrow(/IDENTITY_SIGNING_KEY_ID/);
  });

  it("refuses a signing key outside the global region", () => {
    expect(() =>
      parseConfig(
        baseEnv({
          REGION: "sg",
          GLOBAL_REGION: "us-west",
          GLOBAL_API_URL: "http://10.0.0.5:3002",
          IDENTITY_PUBLIC_KEYS: '{"k1":"PEM"}',
          IDENTITY_SIGNING_KEY: "PEM",
          IDENTITY_SIGNING_KEY_ID: "k1",
          INTERNAL_API_SECRET: "secret",
        }),
      ),
    ).toThrow(/IDENTITY_SIGNING_KEY is set outside/);
  });

  it("refuses a non-global region with no public key to check tokens with", () => {
    expect(() =>
      parseConfig(baseEnv({ REGION: "sg", GLOBAL_REGION: "us-west", GLOBAL_API_URL: "http://10.0.0.5:3002" })),
    ).toThrow(/IDENTITY_PUBLIC_KEYS/);
  });
});
