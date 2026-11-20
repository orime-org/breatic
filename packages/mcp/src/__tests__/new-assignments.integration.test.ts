// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The threads newly handed to a connection (breatic#1488 §7, §15.11): collab
 * adds them to the connection's set in DB4, and each tool result takes what
 * is there, so one hand-over is told once.
 */
import { randomUUID } from "node:crypto";
import { createRedisClient, type Redis } from "@breatic/core";
import { mcpNewAssignmentsKey } from "@breatic/shared";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createNewAssignments } from "@mcp/tools/new-assignments.js";

let redis: Redis;

beforeAll(async () => {
  redis = createRedisClient(inject("REDIS_MCP_URL"), { name: "mcp-test-new-assignments" });
  await redis.connect();
});
afterAll(async () => {
  await redis.quit();
});

describe("createNewAssignments", () => {
  it("takes every member once and leaves the set empty", async () => {
    const prefix = `mcp-test-${randomUUID().slice(0, 8)}`;
    const connectionId = randomUUID();
    await redis.sadd(mcpNewAssignmentsKey(prefix, connectionId), "p:s:a", "p:s:b", "p:s:c");
    const taker = createNewAssignments({ redis, prefix, connectionId });
    expect(await taker.take()).toBe(3);
    expect(await taker.take()).toBe(0);
    expect(await redis.exists(mcpNewAssignmentsKey(prefix, connectionId))).toBe(0);
  });

  it("gives each member to only one of two calls taking at once", async () => {
    const prefix = `mcp-test-${randomUUID().slice(0, 8)}`;
    const connectionId = randomUUID();
    const members = Array.from({ length: 50 }, (_, i) => `p:s:${String(i)}`);
    await redis.sadd(mcpNewAssignmentsKey(prefix, connectionId), ...members);
    const taker = createNewAssignments({ redis, prefix, connectionId });
    const [a, b] = await Promise.all([taker.take(), taker.take()]);
    expect(a + b).toBe(50);
  });

  it("takes nothing from another connection's set", async () => {
    const prefix = `mcp-test-${randomUUID().slice(0, 8)}`;
    const other = randomUUID();
    await redis.sadd(mcpNewAssignmentsKey(prefix, other), "p:s:a");
    expect(await createNewAssignments({ redis, prefix, connectionId: randomUUID() }).take()).toBe(0);
    expect(await redis.scard(mcpNewAssignmentsKey(prefix, other))).toBe(1);
  });
});
