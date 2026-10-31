// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The connection throttle shared by every collab instance (inner#1497 §6.6, B11).
 *
 * Counts and bans live in Redis, so the limit an IP gets is the same however
 * many instances its connections land on. The verdicts match the in-memory
 * extension it replaces: a limit of N allows N connections in the window and
 * denies from the next one on, and a ban holds for the configured minutes.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

import { createRedisClient, initCore, type Redis } from "@breatic/core";
import type { IncomingMessage } from "node:http";
import { createSharedThrottle } from "@collab/infra/shared-throttle.js";
import { createConnectionGate } from "@collab/infra/connection-gate.js";

let redis: Redis;

beforeAll(() => {
  initCore(process.env);
  redis = createRedisClient(process.env.REDIS_URL!, { name: "itest-throttle" });
});

afterAll(async () => {
  await redis.quit();
});

/**
 * Connect once and report the verdict.
 * @param throttle - The throttle.
 * @param ip - The identity, or none (the gate passes the empty string then).
 * @returns "allowed" or "denied".
 */
async function connect(
  throttle: ReturnType<typeof createSharedThrottle>,
  ip: string | undefined,
): Promise<"allowed" | "denied"> {
  return (await throttle.count(ip ?? "")) ? "allowed" : "denied";
}

/**
 * A fresh identity, so cases never share a counter.
 * @returns An address-shaped string unique to this run.
 */
function freshIp(): string {
  return `itest-${randomUUID()}`;
}

describe("createSharedThrottle", () => {
  it("allows the limit and denies from the next connection on", async () => {
    const throttle = createSharedThrottle({ redis, maxAttempts: 2, banMinutes: 5, onError: () => {} });
    const ip = freshIp();
    const outcomes = [];
    for (let i = 0; i < 4; i += 1) outcomes.push(await connect(throttle, ip));
    expect(outcomes).toEqual(["allowed", "allowed", "denied", "denied"]);
  });

  it("shares the count and the ban between two instances", async () => {
    const a = createSharedThrottle({ redis, maxAttempts: 2, banMinutes: 5, onError: () => {} });
    const b = createSharedThrottle({ redis, maxAttempts: 2, banMinutes: 5, onError: () => {} });
    const ip = freshIp();
    expect(await connect(a, ip)).toBe("allowed");
    expect(await connect(b, ip)).toBe("allowed");
    expect(await connect(a, ip)).toBe("denied");
    expect(await connect(b, ip)).toBe("denied");
  });

  it("holds the ban for the configured minutes", async () => {
    const throttle = createSharedThrottle({ redis, maxAttempts: 1, banMinutes: 3, onError: () => {} });
    const ip = freshIp();
    await connect(throttle, ip);
    await connect(throttle, ip);
    const ttl = await redis.ttl(`dev:collab:conn-ban:${ip}`);
    expect(ttl).toBeGreaterThan(170);
    expect(ttl).toBeLessThanOrEqual(180);
  });

  it("reports a banned address as banned and another one as not", async () => {
    const throttle = createSharedThrottle({ redis, maxAttempts: 1, banMinutes: 3, onError: () => {} });
    const ip = freshIp();
    expect(await throttle.isBanned(ip)).toBe(false);
    await connect(throttle, ip);
    await connect(throttle, ip);
    expect(await throttle.isBanned(ip)).toBe(true);
    expect(await throttle.isBanned(freshIp())).toBe(false);
  });

  it("counts each identity separately", async () => {
    const throttle = createSharedThrottle({ redis, maxAttempts: 2, banMinutes: 5, onError: () => {} });
    const ip = freshIp();
    await connect(throttle, ip);
    await connect(throttle, ip);
    expect(await connect(throttle, freshIp())).toBe("allowed");
  });

  it("pools every connection without an identity into one bucket", async () => {
    // The gate always sets the header; this pins what the throttle does if it
    // ever does not, which is the reason the gate must.
    await redis.del("dev:ratelimit:collab-connect:", "dev:collab:conn-ban:");
    const throttle = createSharedThrottle({ redis, maxAttempts: 2, banMinutes: 5, onError: () => {} });
    const outcomes = [];
    for (let i = 0; i < 3; i += 1) outcomes.push(await connect(throttle, undefined));
    await redis.del("dev:ratelimit:collab-connect:", "dev:collab:conn-ban:");
    expect(outcomes).toEqual(["allowed", "allowed", "denied"]);
  });
});

describe("the connection gate feeding the shared throttle", () => {
  /**
   * Run one new WebSocket through the gate's upgrade hook.
   * @param gate - The gate.
   * @param peer - The socket's peer address.
   * @param realIp - What nginx put in `x-real-ip`.
   * @returns "allowed" or "denied".
   */
  async function arrive(
    gate: ReturnType<typeof createConnectionGate>,
    peer: string,
    realIp: string | undefined,
  ): Promise<"allowed" | "denied"> {
    const headers: Record<string, string> = realIp === undefined ? {} : { "x-real-ip": realIp };
    const socket = Object.assign(new EventEmitter(), {
      remoteAddress: peer,
      write: () => true,
      destroy: () => undefined,
    });
    try {
      await gate.onUpgrade({ request: { headers } as unknown as IncomingMessage, socket });
      return "allowed";
    } catch {
      return "denied";
    }
  }

  it("bans a client behind the proxy once it passes the limit", async () => {
    const gate = createConnectionGate(
      createSharedThrottle({ redis, maxAttempts: 2, banMinutes: 5, onError: () => {} }),
    );
    const ip = freshIp();
    const outcomes = [];
    for (let i = 0; i < 4; i += 1) outcomes.push(await arrive(gate, "172.18.0.4", ip));
    expect(outcomes).toEqual(["allowed", "allowed", "denied", "denied"]);
  });

  it("never bans a loopback peer, however many times it connects", async () => {
    const gate = createConnectionGate(
      createSharedThrottle({ redis, maxAttempts: 2, banMinutes: 5, onError: () => {} }),
    );
    const outcomes = [];
    for (let i = 0; i < 10; i += 1) outcomes.push(await arrive(gate, "127.0.0.1", undefined));
    expect(outcomes.every((o) => o === "allowed")).toBe(true);
  });
});
