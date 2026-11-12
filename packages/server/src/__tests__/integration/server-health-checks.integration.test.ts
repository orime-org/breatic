// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The checks the server's `/healthz` runs, as its entry wires them, on a real
 * Postgres and Redis (inner#1717): every connection the server uses is
 * probed, the one Agent chat runs hear their stops and readers on included,
 * and `/healthz` fails while that one is down.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { initCore, startHealthServer } from "@breatic/core";
import { closeChatSubscriberRedis, getChatSubscriberRedis } from "@server/agent/run-stream.js";
import { serverHealthChecks } from "@server/health-checks.js";

beforeAll(() => {
  try {
    initCore(process.env);
  } catch {
    // Already initialised by a sibling suite in this worker.
  }
});

afterAll(async () => {
  await closeChatSubscriberRedis();
});

describe("the server's health checks", () => {
  it("probe both databases, the general Redis and the chat subscriber, and pass while they are up (RT-28)", async () => {
    getChatSubscriberRedis();
    const checks = serverHealthChecks();
    expect(checks.map((c) => c.name)).toEqual(["postgres", "postgres_yjs", "redis_general", "redis_chat_subscriber"]);
    for (const c of checks) expect(await c.check()).toBe(true);
  });

  it("fail /healthz once the chat subscriber's connection is closed (RT-28)", async () => {
    const subscriber = getChatSubscriberRedis();
    await subscriber.ping();
    subscriber.disconnect();
    const health = startHealthServer({ port: 0, serviceName: "server", checks: serverHealthChecks() });
    try {
      await new Promise<void>((resolve) => {
        if (health.server.listening) resolve();
        else health.server.once("listening", () => resolve());
      });
      const { port } = health.server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { checks: Record<string, { ok: boolean }> };
      expect(body.checks.redis_chat_subscriber?.ok).toBe(false);
    } finally {
      await health.stop();
    }
  });
});
