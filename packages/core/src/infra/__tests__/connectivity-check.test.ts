/**
 * Unit tests for the unified boot connectivity check (#909).
 *
 * Pins the contract that server / worker / collab boot on:
 * PostgreSQL + each caller-declared Redis singleton is probed,
 * failures throw `InfraNotReadyError` tagged with the dependency,
 * and a hung probe fails fast via the boot timeout.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Redis } from "ioredis";

vi.mock("@core/db/client.js", () => ({ pingDb: vi.fn() }));
vi.mock("@core/infra/redis.js", () => ({ pingRedis: vi.fn() }));
vi.mock("@core/config/env.js", () => ({
  env: { DATABASE_URL: "postgres://test/db" },
}));

import { checkInfraReady } from "@core/infra/connectivity-check.js";
import { InfraNotReadyError } from "@core/infra/errors.js";
import { pingDb } from "@core/db/client.js";
import { pingRedis } from "@core/infra/redis.js";

const pingDbMock = pingDb as unknown as ReturnType<typeof vi.fn>;
const pingRedisMock = pingRedis as unknown as ReturnType<typeof vi.fn>;

const client = (tag: string): Redis => ({ tag }) as unknown as Redis;

describe("checkInfraReady", () => {
  beforeEach(() => {
    pingDbMock.mockReset().mockResolvedValue(true);
    pingRedisMock.mockReset().mockResolvedValue(true);
  });

  it("resolves when PG + every declared Redis client probe succeeds", async () => {
    await expect(
      checkInfraReady({
        general: client("g"),
        queue: client("q"),
        stream: client("s"),
      }),
    ).resolves.toBeUndefined();
    expect(pingDbMock).toHaveBeenCalledTimes(1);
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
