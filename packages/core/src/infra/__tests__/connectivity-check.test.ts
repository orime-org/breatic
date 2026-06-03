// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Unit tests for the unified boot connectivity check (#909).
 *
 * Pins the contract that server / worker / collab boot on: the
 * business PostgreSQL pool, the separate yjs PostgreSQL pool, and
 * each caller-declared Redis singleton are probed; failures throw
 * `InfraNotReadyError` tagged with the dependency; and a hung probe
 * fails fast via the boot timeout.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Redis } from "ioredis";
import type { Sql } from "postgres";

// The yjs PG pool is probed via `pingDb(yjsRawPg)`. The mock must
// export `yjsRawPg` (vitest throws on access to an undefined export),
// and a stub identity lets a test target the yjs probe specifically.
// `vi.hoisted` so the stub exists when the hoisted `vi.mock` factory runs.
const { yjsRawPgStub } = vi.hoisted(() => ({ yjsRawPgStub: { __yjs: true } }));
vi.mock("@core/db/client.js", () => ({ pingDb: vi.fn(), yjsRawPg: yjsRawPgStub }));
vi.mock("@core/infra/redis.js", () => ({ pingRedis: vi.fn() }));
vi.mock("@core/config/env.js", () => ({
  env: {
    DATABASE_URL: "postgres://test/db",
    YJS_DATABASE_URL: "postgres://test/yjs",
  },
}));

import { checkInfraReady } from "@core/infra/connectivity-check.js";
import { InfraNotReadyError } from "@core/infra/errors.js";
import { pingDb, yjsRawPg } from "@core/db/client.js";
import { pingRedis } from "@core/infra/redis.js";

const pingDbMock = pingDb as unknown as ReturnType<typeof vi.fn>;
const pingRedisMock = pingRedis as unknown as ReturnType<typeof vi.fn>;

const client = (tag: string): Redis => ({ tag }) as unknown as Redis;

describe("checkInfraReady", () => {
  beforeEach(() => {
    pingDbMock.mockReset().mockResolvedValue(true);
    pingRedisMock.mockReset().mockResolvedValue(true);
  });

  it("resolves when both PG pools + every declared Redis client probe succeeds", async () => {
    await expect(
      checkInfraReady({
        general: client("g"),
        queue: client("q"),
        stream: client("s"),
      }),
    ).resolves.toBeUndefined();
    // Two PG probes: the business pool + the separate yjs pool.
    expect(pingDbMock).toHaveBeenCalledTimes(2);
    expect(pingRedisMock).toHaveBeenCalledTimes(3);
  });

  it("throws InfraNotReadyError tagged PostgreSQL when the PG probe fails", async () => {
    pingDbMock.mockRejectedValue(new Error("connection refused"));
    const err = await checkInfraReady({ general: client("g") }).catch((e) => e);
    expect(err).toBeInstanceOf(InfraNotReadyError);
    expect((err as InfraNotReadyError).component).toBe("PostgreSQL");
    // PG fails first, so no Redis probe is attempted.
    expect(pingRedisMock).not.toHaveBeenCalled();
  });

  it("throws InfraNotReadyError tagged 'yjs PostgreSQL' when only the yjs PG probe fails", async () => {
    // Business pool reachable, yjs pool down: the probe is keyed on the
    // yjs client identity so a missing/unreachable yjs DB fails boot.
    pingDbMock.mockImplementation(async (c?: Sql) => {
      if (c === yjsRawPg) throw new Error("yjs connection refused");
      return true;
    });
    const err = await checkInfraReady({ general: client("g") }).catch((e) => e);
    expect(err).toBeInstanceOf(InfraNotReadyError);
    expect((err as InfraNotReadyError).component).toBe("yjs PostgreSQL");
    // yjs PG fails before the Redis loop, so no Redis probe is attempted.
    expect(pingRedisMock).not.toHaveBeenCalled();
  });

  it("tags the failing Redis client by its role name", async () => {
    const stream = client("stream-down");
    // Only the stream client is unreachable.
    pingRedisMock.mockImplementation(async (c: Redis) => c !== stream);
    const err = await checkInfraReady({
      general: client("g"),
      stream,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(InfraNotReadyError);
    expect((err as InfraNotReadyError).component).toBe("Redis (stream)");
  });

  it("fails fast with a boot timeout when a probe hangs", async () => {
    vi.useFakeTimers();
    try {
      pingRedisMock.mockReturnValue(new Promise<boolean>(() => {})); // never settles
      const pending = checkInfraReady({ general: client("g") }).catch((e) => e);
      await vi.advanceTimersByTimeAsync(5001);
      const err = await pending;
      expect(err).toBeInstanceOf(InfraNotReadyError);
      expect((err as InfraNotReadyError).component).toBe("Redis (general)");
    } finally {
      vi.useRealTimers();
    }
  });
});
