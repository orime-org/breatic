// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Integration test: core `checkRateLimit` on a real Redis (inner#1478).
 *
 * Only admitted requests are recorded, so a refused request never extends the
 * wait. Every quota a request names is judged in one script run: when any is
 * full the request is refused and none of them is written.
 *
 * @see packages/core/src/infra/rate-limiter.ts
 */

import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { checkRateLimit, env, getRedis, initCore } from "@breatic/core";

beforeAll(() => {
  initCore(process.env);
});

/**
 * A key no other case uses.
 * @returns The key.
 */
function freshKey(): string {
  return `itest-${randomUUID()}`;
}

/**
 * How many admitted requests a key's window holds.
 * @param key - The quota key, without the env prefix.
 * @returns The count.
 */
async function recorded(key: string): Promise<number> {
  return getRedis().zcard(`${env.ENV}:ratelimit:${key}`);
}

describe("checkRateLimit", () => {
  it("admits max requests, refuses the next one and does not record it", async () => {
    const key = freshKey();
    const quota = [{ key, max: 3, windowSeconds: 60 }];
    for (let i = 0; i < 3; i += 1) {
      expect(await checkRateLimit(getRedis(), quota)).toEqual({ allowed: true });
    }
    const refused = await checkRateLimit(getRedis(), quota);
    expect(refused.allowed).toBe(false);
    await checkRateLimit(getRedis(), quota);
    expect(await recorded(key)).toBe(3);
  });

  it("admits again once the oldest admitted request leaves the window, however many were refused", async () => {
    const key = freshKey();
    const quota = [{ key, max: 1, windowSeconds: 1 }];
    expect((await checkRateLimit(getRedis(), quota)).allowed).toBe(true);
    for (let i = 0; i < 5; i += 1) {
      expect((await checkRateLimit(getRedis(), quota)).allowed).toBe(false);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect((await checkRateLimit(getRedis(), quota)).allowed).toBe(true);
  });

  it("refuses when any quota is full and records nothing in the others", async () => {
    const pair = freshKey();
    const ceiling = freshKey();
    const quotas = [
      { key: ceiling, max: 10, windowSeconds: 60 },
      { key: pair, max: 1, windowSeconds: 60 },
    ];
    expect((await checkRateLimit(getRedis(), quotas)).allowed).toBe(true);
    expect((await checkRateLimit(getRedis(), quotas)).allowed).toBe(false);
    expect(await recorded(ceiling)).toBe(1);
    expect(await recorded(pair)).toBe(1);
  });

  it("answers how long until the fullest quota admits again", async () => {
    const short = freshKey();
    const long = freshKey();
    const quotas = [
      { key: short, max: 1, windowSeconds: 5 },
      { key: long, max: 1, windowSeconds: 120 },
    ];
    await checkRateLimit(getRedis(), quotas);
    const refused = await checkRateLimit(getRedis(), quotas);
    expect(refused).toEqual({ allowed: false, retryAfterSeconds: expect.any(Number) });
    if (refused.allowed) throw new Error("expected a refusal");
    expect(refused.retryAfterSeconds).toBeGreaterThan(110);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(120);
  });

  it("rounds a wait of under a second up to one second", async () => {
    const key = freshKey();
    const quota = [{ key, max: 1, windowSeconds: 1 }];
    await checkRateLimit(getRedis(), quota);
    expect(await checkRateLimit(getRedis(), quota)).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it("admits exactly max of many concurrent requests", async () => {
    const key = freshKey();
    const quota = [{ key, max: 5, windowSeconds: 60 }];
    const verdicts = await Promise.all(Array.from({ length: 20 }, () => checkRateLimit(getRedis(), quota)));
    expect(verdicts.filter((v) => v.allowed)).toHaveLength(5);
    expect(await recorded(key)).toBe(5);
  });
});
