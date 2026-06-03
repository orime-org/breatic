// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Unit tests for {@link pingRedis} — the single Redis PING liveness
 * helper shared by every backend service's /healthz probe and the boot
 * connectivity checks.
 *
 * Exercised with a fake client (only `.ping()` is needed) so no real
 * connection is built. core's own test may import the driver type
 * directly (tests are exempt from lint:no-ioredis-outside-core).
 */

import { describe, it, expect, vi } from "vitest";
import type Redis from "ioredis";
import { pingRedis } from "@core/infra/redis.js";

/**
 * Build a fake ioredis client whose `ping()` resolves to `pong` (or
 * rejects when given an Error).
 * @param pong - The PING reply to resolve, or an Error to reject with
 * @returns A stub typed as `Redis` for {@link pingRedis}
 */
function fakeClient(pong: string | Error): Redis {
  return {
    ping: vi.fn(() =>
      pong instanceof Error ? Promise.reject(pong) : Promise.resolve(pong),
    ),
  } as unknown as Redis;
}

describe("pingRedis", () => {
  it("returns true when PING replies PONG", async () => {
    await expect(pingRedis(fakeClient("PONG"))).resolves.toBe(true);
  });

  it("returns false when PING replies something other than PONG", async () => {
    await expect(pingRedis(fakeClient("LOADING"))).resolves.toBe(false);
  });

  it("propagates the driver error when the connection is unreachable", async () => {
    await expect(
      pingRedis(fakeClient(new Error("Connection is closed."))),
    ).rejects.toThrow(/Connection is closed/);
  });
});
