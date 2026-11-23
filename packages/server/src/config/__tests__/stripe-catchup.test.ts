// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { MONOREPO_ROOT } from "@breatic/core";
import { getStripeCatchUpLookbackHours, stripeCatchUpConfigSchema } from "@server/config/stripe-catchup.js";

describe("stripe catch-up config", () => {
  it("looks back four days by default: Stripe's three days of retries and one more", () => {
    expect(stripeCatchUpConfigSchema.parse({}).lookback_hours).toBe(96);
  });

  it("refuses a lookback that is not a positive whole number of hours", () => {
    expect(() => stripeCatchUpConfigSchema.parse({ lookback_hours: 0 })).toThrow();
    expect(() => stripeCatchUpConfigSchema.parse({ lookback_hours: 1.5 })).toThrow();
  });

  it("returns the lookback the shipped file sets", () => {
    const raw = parse(readFileSync(resolve(MONOREPO_ROOT, "config", "stripe-catchup.yaml"), "utf-8")) as { lookback_hours: number };
    expect(getStripeCatchUpLookbackHours()).toBe(raw.lookback_hours);
  });
});
