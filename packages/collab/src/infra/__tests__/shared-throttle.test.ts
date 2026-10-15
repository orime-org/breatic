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
  it("allows the connection and reports the error", async () => {
    const broken = {
      get: vi.fn(async () => {
        throw new Error("connection is closed");
      }),
    } as unknown as Redis;
    const onError = vi.fn();
    const throttle = createSharedThrottle({ redis: broken, maxAttempts: 2, banMinutes: 5, onError });

    await expect(
      throttle("203.0.113.9"),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "203.0.113.9");
  });
});
