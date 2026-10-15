// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The run-once lease config: the schema refuses a lease too short to renew,
 * and the shipped file's lease is what the accessor returns.
 */

import { describe, it, expect, vi } from "vitest";

// The package setup stubs this loader for the route suites; this file tests
// the loader itself.
vi.unmock("@server/config/idempotency.js");

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { MONOREPO_ROOT } from "@breatic/core";
import { idempotencyConfigSchema, getRunningLeaseMs } from "@server/config/idempotency.js";

describe("idempotency config", () => {
  it("defaults the running lease to 30 seconds", () => {
    expect(idempotencyConfigSchema.parse({}).running_lease_ms).toBe(30_000);
  });

  it("rejects a lease too short to renew a third of the way through", () => {
    expect(() => idempotencyConfigSchema.parse({ running_lease_ms: 2 })).toThrow();
  });

  it("returns the lease the shipped file sets", () => {
    const raw = parse(
      readFileSync(resolve(MONOREPO_ROOT, "config", "idempotency.yaml"), "utf-8"),
    ) as { running_lease_ms: number };
    expect(getRunningLeaseMs()).toBe(raw.running_lease_ms);
  });
});
