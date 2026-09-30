// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The sign-up code settings: the schema applies its defaults and rejects
 * non-positive values, and the accessor returns what `config/auth.yaml` ships.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { MONOREPO_ROOT } from "@breatic/core";
import { authConfigSchema, getSignupCodeConfig } from "@server/config/auth.js";

describe("auth config - schema", () => {
  it("defaults to a ten-minute code, five tries and a one-minute resend wait", () => {
    expect(authConfigSchema.parse({}).signup_code).toEqual({
      ttl_seconds: 600,
      max_attempts_per_code: 5,
      resend_cooldown_seconds: 60,
    });
  });

  it("rejects a non-positive value", () => {
    expect(() => authConfigSchema.parse({ signup_code: { ttl_seconds: 0 } })).toThrow();
    expect(() => authConfigSchema.parse({ signup_code: { max_attempts_per_code: -1 } })).toThrow();
    expect(() => authConfigSchema.parse({ signup_code: { resend_cooldown_seconds: 1.5 } })).toThrow();
  });
});

describe("auth config - accessor reads config/auth.yaml", () => {
  it("returns the shipped values", () => {
    const shipped = parse(readFileSync(resolve(MONOREPO_ROOT, "config/auth.yaml"), "utf-8")) as {
      signup_code: Record<string, number>;
    };
    expect(getSignupCodeConfig()).toEqual({
      ttlSeconds: shipped.signup_code.ttl_seconds,
      maxAttemptsPerCode: shipped.signup_code.max_attempts_per_code,
      resendCooldownSeconds: shipped.signup_code.resend_cooldown_seconds,
    });
  });
});
