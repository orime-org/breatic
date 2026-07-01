// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Unit tests for the collab space-delete distributed lock.
 *
 * The lock serializes `space:delete` per project ACROSS collab instances
 * (production runs multiple instances synced via Redis pub/sub). Without
 * it, two collaborators on different instances can each pass the
 * "keep >=1 space" guard against their own not-yet-synced in-memory doc
 * and race the project's space count to zero. The lock lives on
 * `REDIS_COLLAB_URL` (DB3, collab cross-instance coordination).
 *
 * The lock is FENCED: each acquire writes a unique token and releases via
 * a check-and-del Lua script, so an instance whose lock expired (and was
 * re-acquired by another instance) never deletes someone else's lock.
 *
 * `getCollabRedis` + `env` are mocked so these run with a fake in-memory
 * Redis — no real connection, no initCore.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { getCollabRedisMock } = vi.hoisted(() => ({
  getCollabRedisMock: vi.fn(),
}));

vi.mock("@breatic/core", () => ({
  getCollabRedis: getCollabRedisMock,
  env: { ENV: "test" },
}));

import {
  withSpaceDeleteLock,
  SpaceDeleteLockBusyError,
} from "../services/space-delete-lock.js";

const PID = "11111111-1111-4111-8111-111111111111";

/**
 * Minimal in-memory fake of the ioredis commands the lock uses:
 * `set` (NX EX), and `eval` (the check-and-del release script).
 * @param opts.busy - when true, `set` always reports the key already held.
 */
function makeFakeRedis(opts: { busy?: boolean } = {}) {
  const store = new Map<string, string>();
  return {
    store,
    set: vi.fn(async (key: string, val: string) => {
      if (opts.busy || store.has(key)) return null;
      store.set(key, val);
      return "OK";
    }),
    // Simulate the check-and-del Lua script: DEL only if the stored value
    // still equals our token (fencing).
    eval: vi.fn(async (_script: string, _numKeys: number, key: string, token: string) => {
      if (store.get(key) === token) {
        store.delete(key);
        return 1;
      }
      return 0;
    }),
  };
}

beforeEach(() => {
  getCollabRedisMock.mockReset();
});

describe("withSpaceDeleteLock", () => {
  it("acquires with SET NX EX (unique token), runs fn, then releases via check-and-del", async () => {
    const redis = makeFakeRedis();
    getCollabRedisMock.mockReturnValue(redis);
    const fn = vi.fn(async () => "done");

    const result = await withSpaceDeleteLock(PID, fn);

    expect(result).toBe("done");
    expect(fn).toHaveBeenCalledOnce();
    // Acquired with a unique token (not a fixed "1"), NX + EX.
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining(`collab:lock:space-delete:${PID}`),
      expect.any(String),
      "EX",
      expect.any(Number),
      "NX",
    );
    const token = redis.set.mock.calls[0]?.[1];
    expect(token).toBeTruthy();
    expect(token).not.toBe("1");
    // Released via check-and-del with the SAME key + token.
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      expect.stringContaining(`collab:lock:space-delete:${PID}`),
      token,
    );
    expect(redis.store.size).toBe(0);
  });

  it("releases the lock even when fn throws (finally)", async () => {
    const redis = makeFakeRedis();
    getCollabRedisMock.mockReturnValue(redis);
    const boom = new Error("boom");

    await expect(
      withSpaceDeleteLock(PID, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(redis.eval).toHaveBeenCalledOnce();
    expect(redis.store.size).toBe(0);
  });

  it("throws SpaceDeleteLockBusyError without running fn when the lock stays held", async () => {
    const redis = makeFakeRedis({ busy: true });
    getCollabRedisMock.mockReturnValue(redis);
    const fn = vi.fn(async () => "should not run");

    await expect(
      withSpaceDeleteLock(PID, fn, { retryAttempts: 3, retryDelayMs: 0 }),
    ).rejects.toBeInstanceOf(SpaceDeleteLockBusyError);

    expect(fn).not.toHaveBeenCalled();
    expect(redis.set).toHaveBeenCalledTimes(3);
    // Never tries to release a lock it does not own.
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it("does NOT release a lock it no longer owns (fencing — another instance's token survives)", async () => {
    const redis = makeFakeRedis();
    getCollabRedisMock.mockReturnValue(redis);

    await withSpaceDeleteLock(PID, async () => {
      // Simulate our lock expiring mid-fn and another instance re-acquiring
      // it: overwrite the stored value with a DIFFERENT token.
      const key = [...redis.store.keys()][0];
      if (!key) throw new Error("expected the lock key to be set");
      redis.store.set(key, "another-instance-token");
    });

    // Our check-and-del saw the token mismatch → left the other instance's
    // lock intact instead of deleting it.
    expect(redis.store.size).toBe(1);
    expect([...redis.store.values()][0]).toBe("another-instance-token");
  });

  it("scopes the lock key per project so different projects don't collide", async () => {
    const redis = makeFakeRedis();
    getCollabRedisMock.mockReturnValue(redis);

    await withSpaceDeleteLock("proj-A", async () => undefined);
    await withSpaceDeleteLock("proj-B", async () => undefined);

    const keys = redis.set.mock.calls.map((c) => c[0]);
    expect(keys[0]).toContain("proj-A");
    expect(keys[1]).toContain("proj-B");
    expect(keys[0]).not.toBe(keys[1]);
  });
});
