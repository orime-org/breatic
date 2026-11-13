// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * `getMcpRedis()` (#1488 §6): the DB 4 client for external-agent commands,
 * replies, counters and in-flight task lists. It is built like the other
 * singletons, through `createRedisClient`, from `REDIS_MCP_URL`, once per
 * process, and released on shutdown.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";

const { ctorCalls, quitCalls, MockRedis } = vi.hoisted(() => {
  const ctorCalls: Array<{ url: string; options: Record<string, unknown> }> = [];
  const quitCalls: string[] = [];

  class MockRedis {
    private readonly url: string;
    constructor(url: string, options: Record<string, unknown>) {
      this.url = url;
      ctorCalls.push({ url, options });
    }
    on(): this {
      return this;
    }
    async quit(): Promise<"OK"> {
      quitCalls.push(this.url);
      return "OK";
    }
  }

  return { ctorCalls, quitCalls, MockRedis };
});

vi.mock("ioredis", () => ({ default: MockRedis }));

import { initCore } from "@core/config/runtime.js";
import { closeMcpRedis, getMcpRedis } from "@core/infra/redis.js";

beforeAll(() => {
  initCore({
    DATABASE_URL: "postgres://breatic:breatic@localhost:5432/breatic",
    YJS_DATABASE_URL: "postgres://breatic:breatic@localhost:5432/breatic_yjs",
    REDIS_MCP_URL: "redis://cache:6390/4",
  });
});

describe("getMcpRedis", () => {
  it("connects to REDIS_MCP_URL through the shared factory", () => {
    const before = ctorCalls.length;
    getMcpRedis();
    const call = ctorCalls[before]!;
    expect(call.url).toBe("redis://cache:6390/4");
    expect(call.options.keepAlive).toBeTypeOf("number");
    expect(call.options.reconnectOnError).toBeTypeOf("function");
  });

  it("builds one client per process", () => {
    const before = ctorCalls.length;
    expect(getMcpRedis()).toBe(getMcpRedis());
    expect(ctorCalls.length).toBe(before);
  });

  it("quits the client on close and builds a fresh one after", async () => {
    const first = getMcpRedis();
    await closeMcpRedis();
    expect(quitCalls).toContain("redis://cache:6390/4");
    expect(getMcpRedis()).not.toBe(first);
  });

  it("does nothing when closed twice", async () => {
    await closeMcpRedis();
    const quits = quitCalls.length;
    await closeMcpRedis();
    expect(quitCalls.length).toBe(quits);
  });
});
