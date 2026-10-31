// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import fc from "fast-check";
import type Redis from "ioredis";
import pino from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { envMock } = vi.hoisted(() => ({
  envMock: { ENV: "dev", REDIS_KEY_PREFIX: "session-tests" },
}));

vi.mock("@core/config/env.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  env: envMock,
}));

import { getSession } from "@core/infra/session-store.js";

/** The only Redis operations the session lookup may observe. */
interface SessionRedisStub {
  get: ReturnType<typeof vi.fn<(key: string) => Promise<string | null>>>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  expire: ReturnType<typeof vi.fn>;
}

/**
 * Give the lookup observable storage operations without opening a connection.
 */
function sessionRedis(): SessionRedisStub {
  return { get: vi.fn(), set: vi.fn(), del: vi.fn(), expire: vi.fn() };
}

/**
 * Observe whether the existing session IO boundary returns or rejects.
 */
async function rejectedLookup(redis: SessionRedisStub, token: string): Promise<unknown> {
  try {
    await getSession(redis as unknown as Redis, token);
    return "resolved";
  } catch (error) {
    return error;
  }
}

beforeEach(() => {
  envMock.ENV = "dev";
  envMock.REDIS_KEY_PREFIX = "session-tests";
});

describe("getSession", () => {
  it.each(["user-a", null])("returns the stored value %s with one read and unchanged TTL", async (value) => {
    const redis = sessionRedis();
    redis.get.mockResolvedValue(value);

    const result = await getSession(redis as unknown as Redis, "token-a");

    expect(result).toBe(value);
    expect(redis.get.mock.calls).toEqual([["dev:session:token-a"]]);
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
    expect(redis.expire).not.toHaveBeenCalled();
  });

  it.each(["dev", "staging", "prod"])("uses the %s ENV namespace independently of the cookie prefix", async (environment) => {
    const redis = sessionRedis();
    redis.get.mockResolvedValue("user-a");
    envMock.ENV = environment;
    envMock.REDIS_KEY_PREFIX = "other-cookie-prefix";

    expect(await getSession(redis as unknown as Redis, "token-a")).toBe("user-a");
    expect(redis.get.mock.calls).toEqual([[`${environment}:session:token-a`]]);
  });

  it("removes session credentials and Redis command arguments before application serialization", async () => {
    const redis = sessionRedis();
    const token = "secret/session?token=one";
    const encoded = encodeURIComponent(token);
    const original = Object.assign(new Error(`WRONGTYPE session lookup ${token} ${encoded}`), {
      code: "WRONGTYPE",
      command: { name: "get", args: [`dev:session:${token}`] },
      vendorSecret: token,
    });
    original.stack = `Error: session lookup ${token}\n at GET ${encoded}`;
    redis.get.mockRejectedValue(original);

    const rejection = await rejectedLookup(redis, token);

    expect(redis.get.mock.calls).toEqual([[`dev:session:${token}`]]);
    expect(rejection).toBeInstanceOf(Error);
    const safe = rejection as Error & { code?: string; sourceType?: string };
    const wire = JSON.stringify(pino.stdSerializers.err(safe));
    expect(wire).not.toContain(token);
    expect(wire).not.toContain(encoded);
    expect(rejection).not.toBe(original);
    expect(safe.message).toBe("WRONGTYPE session lookup [Redacted] [Redacted]");
    expect(safe.code).toBe("WRONGTYPE");
    expect(safe.sourceType).toBe("Error");
    expect(wire).toContain("session lookup");
    expect(wire).not.toContain("command");
    expect(wire).not.toContain("vendorSecret");
    expect(original.command.args).toEqual([`dev:session:${token}`]);
    expect(original.message).toBe(`WRONGTYPE session lookup ${token} ${encoded}`);
  });

  it.each(["Command timed out", "Connection is closed."])("preserves the dependency diagnostic %s as an Error", async (message) => {
    const redis = sessionRedis();
    redis.get.mockRejectedValue(new Error(message));

    const rejection = await rejectedLookup(redis, "token-a");

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).constructor).toBe(Error);
    expect((rejection as Error).message).toBe(message);
    expect(redis.get.mock.calls).toEqual([["dev:session:token-a"]]);
  });

  it.each([
    { label: "string", value: "failed secret-token" },
    { label: "number", value: 42 },
    { label: "true", value: true },
    { label: "false", value: false },
    { label: "null", value: null },
    { label: "undefined", value: undefined },
    { label: "bigint", value: 12n },
    { label: "symbol", value: Symbol("secret-token") },
    { label: "object", value: { privatePayload: "secret-token", command: { args: ["secret-token"] } } },
  ])("normalizes a $label rejection at the IO boundary", async ({ value }) => {
    const redis = sessionRedis();
    redis.get.mockRejectedValue(value);

    const rejection = await rejectedLookup(redis, "secret-token");

    expect(rejection).toBeInstanceOf(Error);
    const wire = JSON.stringify(pino.stdSerializers.err(rejection as Error));
    expect(wire).not.toContain("secret-token");
    expect(wire).not.toContain("command");
    expect(wire).not.toContain("privatePayload");
    expect(redis.get.mock.calls).toEqual([["dev:session:secret-token"]]);
  });

  it("normalizes a function rejection without exposing its source or properties", async () => {
    /** Return a fixture credential embedded in the rejected function's source. */
    function rejectedFunction(): string {
      return "secret-token";
    }
    const redis = sessionRedis();
    redis.get.mockRejectedValue(Object.assign(rejectedFunction, {
      privatePayload: "secret-token",
      command: { args: ["secret-token"] },
    }));

    const rejection = await rejectedLookup(redis, "secret-token");

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message.toLowerCase()).toContain("function");
    const wire = JSON.stringify(pino.stdSerializers.err(rejection as Error));
    expect(wire).not.toContain("secret-token");
    expect(wire).not.toContain("rejectedFunction");
    expect(wire).not.toContain("privatePayload");
    expect(wire).not.toContain("command");
    expect(redis.get.mock.calls).toEqual([["dev:session:secret-token"]]);
  });

  it("preserves generated user IDs and null results with the exact lookup key", async () => {
    await fc.assert(fc.asyncProperty(
      fc.option(fc.uuid(), { nil: null }),
      fc.array(fc.constantFrom("a", "B", "0", "/", "?", "=", "+", "%"), { minLength: 1, maxLength: 30 }),
      async (userId, characters) => {
        const token = characters.join("");
        const redis = sessionRedis();
        redis.get.mockResolvedValue(userId);

        expect(await getSession(redis as unknown as Redis, token)).toBe(userId);
        expect(redis.get.mock.calls).toEqual([[`dev:session:${token}`]]);
        expect(redis.set).not.toHaveBeenCalled();
        expect(redis.del).not.toHaveBeenCalled();
        expect(redis.expire).not.toHaveBeenCalled();
      },
    ));
  });
});
