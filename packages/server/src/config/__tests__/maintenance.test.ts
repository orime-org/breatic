// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import fc from "fast-check";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { MONOREPO_ROOT } from "@breatic/core";
import { maintenanceSchema, getMaintenanceConfig } from "@server/config/maintenance.js";

const valid = { enabled: false, loop_interval_seconds: 30, check_interval_seconds: 3600, batch_size: 20, concurrency: 1, lease_seconds: 120, protection_seconds: 86400, preview_ttl_seconds: 600, storage_timeout_ms: 15000 };

describe("explicit recurring maintenance configuration", () => {
  it("ships disabled until deployment verification and maps every tracked field", () => {
    const tracked = maintenanceSchema.parse(parse(readFileSync(resolve(MONOREPO_ROOT, "config/maintenance.yaml"), "utf8")));
    expect(tracked.enabled).toBe(false);
    expect(getMaintenanceConfig()).toEqual({ enabled: false, loopIntervalSeconds: tracked.loop_interval_seconds, checkIntervalSeconds: tracked.check_interval_seconds, batchSize: tracked.batch_size, concurrency: tracked.concurrency, leaseSeconds: tracked.lease_seconds, protectionSeconds: tracked.protection_seconds, previewTtlSeconds: tracked.preview_ttl_seconds, storageTimeoutMs: tracked.storage_timeout_ms });
  });

  it.each(Object.keys(valid) as (keyof typeof valid)[])("requires the explicit %s field", (key) => {
    const input: Record<string, unknown> = { ...valid };
    delete input[key];
    expect(maintenanceSchema.safeParse(input).success).toBe(false);
  });

  it.each(["loop_interval_seconds", "check_interval_seconds", "batch_size", "concurrency", "lease_seconds", "preview_ttl_seconds", "storage_timeout_ms"])("requires positive integer %s", (key) => {
    for (const value of [0, -1, 1.5, "20"]) expect(maintenanceSchema.safeParse({ ...valid, [key]: value }).success).toBe(false);
  });

  it("permits zero protection and refuses negative protection, unknown settings and oversized batches", () => {
    expect(maintenanceSchema.safeParse({ ...valid, protection_seconds: 0 }).success).toBe(true);
    for (const input of [{ ...valid, protection_seconds: -1 }, { ...valid, unexpected: true }, { ...valid, batch_size: 101 }]) expect(maintenanceSchema.safeParse(input).success).toBe(false);
  });

  it("requires a lease strictly beyond four serial storage deadlines and writeback headroom", () => {
    expect(maintenanceSchema.safeParse({ ...valid, storage_timeout_ms: 1000, lease_seconds: 13 }).success).toBe(false);
    expect(maintenanceSchema.safeParse({ ...valid, storage_timeout_ms: 1000, lease_seconds: 14 }).success).toBe(false);
    expect(maintenanceSchema.safeParse({ ...valid, storage_timeout_ms: 1000, lease_seconds: 15 }).success).toBe(true);
  });

  it("preserves the serial-call lease inequality for generated storage deadlines", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 100_000 }), (timeout) => {
      const insufficient = Math.floor((4 * timeout + 10_000) / 1000);
      expect(maintenanceSchema.safeParse({ ...valid, storage_timeout_ms: timeout, lease_seconds: insufficient }).success).toBe(false);
      expect(maintenanceSchema.safeParse({ ...valid, storage_timeout_ms: timeout, lease_seconds: insufficient + 1 }).success).toBe(true);
    }), { numRuns: 100, seed: 30 });
  });
});
