// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Server `/healthz` check wiring.
 *
 * The contract of the health server itself lives in
 * `packages/core/src/infra/__tests__/health-server.test.ts`; this file pins
 * that each of the server's checks (`serverHealthChecks`, which the entry
 * hands the health server) forwards what its connection's probe answers.
 * The probes are core's shared `pingDb()` and `pingRedis()`; what they do
 * against a real connection is pinned in core and in
 * `integration/server-health-checks.integration.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const probes = vi.hoisted(() => ({
  db: vi.fn(async (_client?: unknown) => true),
  redis: vi.fn(async (_client: unknown) => true),
}));

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pingDb: probes.db,
  pingRedis: probes.redis,
  getRedis: () => "general",
  yjsRawPg: "yjs",
}));

vi.mock("@server/agent/run-stream.js", () => ({ getChatSubscriberRedis: () => "subscriber" }));

const { serverHealthChecks } = await import("@server/health-checks.js");

/**
 * Run one of the server's checks by name.
 * @param name - The check.
 * @returns What it answered.
 */
async function run(name: string): Promise<boolean> {
  return serverHealthChecks().find((c) => c.name === name)!.check();
}

beforeEach(() => {
  probes.db.mockReset().mockResolvedValue(true);
  probes.redis.mockReset().mockResolvedValue(true);
});

describe("server healthz check wiring", () => {
  it("probes the product database, then the Yjs one, with core's shared helper", async () => {
    await expect(run("postgres")).resolves.toBe(true);
    await expect(run("postgres_yjs")).resolves.toBe(true);
    expect(probes.db.mock.calls).toEqual([[], ["yjs"]]);
  });

  it("answers false when a database probe does", async () => {
    probes.db.mockResolvedValue(false);
    await expect(run("postgres")).resolves.toBe(false);
  });

  it("probes the general Redis and the chat subscriber's own connection", async () => {
    await expect(run("redis_general")).resolves.toBe(true);
    await expect(run("redis_chat_subscriber")).resolves.toBe(true);
    expect(probes.redis.mock.calls).toEqual([["general"], ["subscriber"]]);
  });

  it("answers false when a Redis probe does", async () => {
    probes.redis.mockResolvedValue(false);
    await expect(run("redis_chat_subscriber")).resolves.toBe(false);
  });
});
