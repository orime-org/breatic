// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The run-once lease config: the schema refuses a lease too short to renew,
 * and the shipped file's lease is what the accessor returns.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { MONOREPO_ROOT } from "@core/config/env.js";
import { idempotencyConfigSchema, getRunningLeaseMs } from "@core/config/idempotency.js";

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

  it("reads the file in the configuration directory the caller names", () => {
    const dir = mkdtempSync(join(tmpdir(), "idempotency-"));
    writeFileSync(join(dir, "idempotency.yaml"), "running_lease_ms: 450\n");
    expect(getRunningLeaseMs(dir)).toBe(450);
  });
});
