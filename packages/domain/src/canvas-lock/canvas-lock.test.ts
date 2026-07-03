// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Canvas-node lock primitives — the overwrite-mode exclusivity that also
 * serializes gen assignment for backend AIGC (#1580 #7).
 *
 * `reacquireCanvasNodeLock` exists for BullMQ retries: `runTask` releases
 * the lock in its `finally` on EVERY attempt (including a rethrow that
 * schedules a retry), so a retry attempt must take the lock back before
 * touching the node — and must tolerate attempt 1's release having failed
 * (holder is still this task). Adversarial finding #1580-adv (retry
 * self-fencing) made this a hard requirement.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { initCore } from "@breatic/core";
import type { Redis } from "@breatic/core";
import {
  acquireCanvasNodeLock,
  reacquireCanvasNodeLock,
  canvasNodeLockKey,
} from "./canvas-lock.js";

beforeAll(() => {
  initCore(process.env);
});

/**
 * Minimal in-memory stand-in for the two Redis commands the lock uses.
 * @returns The fake client and its backing store.
 */
function fakeRedis(): { redis: Redis; store: Map<string, string> } {
  const store = new Map<string, string>();
  const redis = {
    set: async (
      key: string,
      value: string,
      ..._args: unknown[]
    ): Promise<string | null> => {
      if (store.has(key)) return null; // NX semantics
      store.set(key, value);
      return "OK";
    },
    get: async (key: string): Promise<string | null> =>
      store.get(key) ?? null,
  } as unknown as Redis;
  return { redis, store };
}

const PID = "11111111-1111-4111-8111-111111111111";
const NODE = "22222222-2222-4222-9222-222222222222";

describe("reacquireCanvasNodeLock (#1580 adversarial fix: retry lock continuity)", () => {
  it("acquires a free lock (first attempt after a clean release)", async () => {
    const { redis } = fakeRedis();
    expect(await reacquireCanvasNodeLock(PID, NODE, "task-1", redis)).toBe(true);
  });

  it("succeeds when the lock is already held by THIS task (release failed / never ran)", async () => {
    const { redis } = fakeRedis();
    expect(await acquireCanvasNodeLock(PID, NODE, "task-1", redis)).toBe(true);
    expect(await reacquireCanvasNodeLock(PID, NODE, "task-1", redis)).toBe(true);
  });

  it("fails when another task took the node between attempts", async () => {
    const { redis } = fakeRedis();
    expect(await acquireCanvasNodeLock(PID, NODE, "task-other", redis)).toBe(true);
    expect(await reacquireCanvasNodeLock(PID, NODE, "task-1", redis)).toBe(false);
  });

  it("uses the same namespaced key as acquire", async () => {
    const { redis, store } = fakeRedis();
    await reacquireCanvasNodeLock(PID, NODE, "task-1", redis);
    expect(store.has(canvasNodeLockKey(PID, NODE))).toBe(true);
  });
});
