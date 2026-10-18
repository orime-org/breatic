// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The shared throttle lets connections through when Redis cannot answer
 * (inner#1497 §6.6): the same choice the seat registry makes, and an outage is an
 * operations event that the error log reports.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@breatic/core", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, env: { ENV: "dev" } };
});

import type { Redis } from "@breatic/core";
import { createSharedThrottle } from "@collab/infra/shared-throttle.js";

describe("createSharedThrottle when Redis fails", () => {
  /** A Redis client whose every command fails. */
  function brokenRedis(): Redis {
    const fail = vi.fn(async () => {
      throw new Error("connection is closed");
    });
    return { get: fail, set: fail, eval: fail } as unknown as Redis;
  }

  it("lets a new connection through and reports the error", async () => {
    const onError = vi.fn();
    const throttle = createSharedThrottle({ redis: brokenRedis(), maxAttempts: 2, banMinutes: 5, onError });

    await expect(throttle.count("203.0.113.9")).resolves.toBe(true);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "203.0.113.9");
  });

  it("reports an address as not banned and reports the error", async () => {
    const onError = vi.fn();
    const throttle = createSharedThrottle({ redis: brokenRedis(), maxAttempts: 2, banMinutes: 5, onError });

    await expect(throttle.isBanned("203.0.113.9")).resolves.toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "203.0.113.9");
  });
});
