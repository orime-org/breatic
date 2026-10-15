// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `runOnce` against a real Redis: the claim, the lease and the finished
 * answer are Lua scripts, so their atomicity is only observable on a server
 * that runs them.
 *
 * The lease is shortened to 300 ms so a handler can outlive it inside a
 * case; the shipped lease is in `config/idempotency.yaml`.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";

vi.mock("@server/config/idempotency.js", () => ({ getRunningLeaseMs: () => 300 }));

import crypto from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Hono } from "hono";
import {
  AppError,
  env,
  getRedis,
  initCore,
  initLogger,
  loadLocales,
  logger,
} from "@breatic/core";
import { IDEMPOTENCY_RETENTION_SECONDS } from "@breatic/shared";
import { errorHandler } from "@server/middleware/error-handler.js";
import { runOnce } from "@server/middleware/run-once.js";
import type { AuthVariables } from "@server/middleware/auth.js";

loadLocales();

/** A promise the case resolves by hand. */
interface Gate {
  promise: Promise<void>;
  open: () => void;
}

/**
 * A promise the case resolves by hand.
 * @returns The promise and the function that resolves it.
 */
function gate(): Gate {
  let open = (): void => {};
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
}

/**
 * Sleep for real time.
 * @param ms - How long.
 * @returns A promise that resolves after `ms`.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let runs = 0;
let hold: Gate | null = null;
let fail: AppError | null = null;

/**
 * An app with one run-once route, a stub sign-in and the real error handler.
 * @returns The app.
 */
function buildApp(): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.onError(errorHandler);
  app.use("*", async (c, next) => {
    c.set("user", {
      id: c.req.header("x-user") ?? "user-a",
      email: "a@example.test",
      membershipTier: "base",
      locale: "en",
    });
    await next();
  });
  app.post("/run", runOnce("generate"), async (c) => {
    runs += 1;
    if (hold) await hold.promise;
    if (fail) throw fail;
    return c.json({ data: { run: runs } }, 201);
  });
  return app;
}

/**
 * Post to the run-once route.
 * @param app - The app.
 * @param opts - Key, body and user.
 * @param opts.key - The `Idempotency-Key`, or undefined to send none.
 * @param opts.body - The JSON body.
 * @param opts.user - Who is signed in.
 * @returns The response.
 */
function post(
  app: Hono<{ Variables: AuthVariables }>,
  opts: { key?: string; body?: unknown; user?: string },
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.key !== undefined) headers["Idempotency-Key"] = opts.key;
  if (opts.user !== undefined) headers["x-user"] = opts.user;
  return Promise.resolve(
    app.request("/run", { method: "POST", headers, body: JSON.stringify(opts.body ?? { a: 1 }) }),
  );
}

/**
 * The Redis key a record lives under.
 * @param key - The `Idempotency-Key`.
 * @param user - The signed-in user.
 * @returns The Redis key.
 */
function recordKey(key: string, user = "user-a"): string {
  return `${env.REDIS_KEY_PREFIX}:server:idempotency:${user}:generate:${key}`;
}

let app: Hono<{ Variables: AuthVariables }>;

beforeAll(() => {
  initCore(process.env);
  // A real pino instance, as in production: the default export is a Proxy
  // that a spy cannot attach to.
  initLogger("run-once-test", {
    logsRoot: resolve(tmpdir(), "breatic-test-logs"),
    debug: false,
    console: "none",
  });
  app = buildApp();
});

afterEach(() => {
  runs = 0;
  // A case that failed before opening its gate would leave the handler hanging.
  hold?.open();
  hold = null;
  fail = null;
  vi.restoreAllMocks();
});

describe("runOnce", () => {
  it("refuses a request without a key, without running it", async () => {
    const res = await post(app, {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("This page was updated. Refresh it and try again.");
    expect(runs).toBe(0);
  });

  it("runs the first press and marks the answer done", async () => {
    const res = await post(app, { key: crypto.randomUUID() });
    expect(res.status).toBe(201);
    expect(res.headers.get("Idempotency-Status")).toBe("done");
    expect(res.headers.get("Idempotent-Replayed")).toBeNull();
    expect(runs).toBe(1);
  });

  it("replays a finished answer to the same key without running again", async () => {
    const key = crypto.randomUUID();
    await post(app, { key });
    const again = await post(app, { key });
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual({ data: { run: 1 } });
    expect(again.headers.get("Idempotency-Status")).toBe("done");
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
    expect(runs).toBe(1);
  });

  it("keeps the finished answer for the scope's retention", async () => {
    const key = crypto.randomUUID();
    await post(app, { key });
    const ttl = await getRedis().ttl(recordKey(key));
    expect(ttl).toBeGreaterThan(IDEMPOTENCY_RETENTION_SECONDS.generate - 5);
    expect(ttl).toBeLessThanOrEqual(IDEMPOTENCY_RETENTION_SECONDS.generate);
  });

  it("refuses the same key with a different body", async () => {
    const key = crypto.randomUUID();
    await post(app, { key, body: { a: 1 } });
    const other = await post(app, { key, body: { a: 2 } });
    expect(other.status).toBe(422);
    const body = (await other.json()) as { error: { message: string } };
    expect(body.error.message).toBe("This request does not match the one sent before.");
    expect(runs).toBe(1);
  });

  it("answers 409 in_progress while the first is still running", async () => {
    const key = crypto.randomUUID();
    hold = gate();
    const first = post(app, { key });
    await sleep(50);
    const second = await post(app, { key });
    expect(second.status).toBe(409);
    expect(second.headers.get("Idempotency-Status")).toBe("in_progress");
    hold.open();
    expect((await first).status).toBe(201);
    expect(runs).toBe(1);
  });

  it("lets two presses race and runs only one", async () => {
    const key = crypto.randomUUID();
    hold = gate();
    const [a, b] = [post(app, { key }), post(app, { key })];
    await sleep(50);
    hold.open();
    const statuses = [(await a).status, (await b).status].sort();
    expect(statuses).toEqual([201, 409]);
    expect(runs).toBe(1);
  });

  it("keys per user", async () => {
    const key = crypto.randomUUID();
    await post(app, { key, user: "user-a" });
    const other = await post(app, { key, user: "user-b" });
    expect(other.status).toBe(201);
    expect(runs).toBe(2);
  });

  it("stores and replays the error a handler threw", async () => {
    const key = crypto.randomUUID();
    fail = new AppError(403, "nope");
    const res = await post(app, { key });
    expect(res.status).toBe(403);
    expect(res.headers.get("Idempotency-Status")).toBe("done");
    fail = null;
    const again = await post(app, { key });
    expect(again.status).toBe(403);
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
    expect(runs).toBe(1);
  });

  it("renews the lease while a handler outlives it", async () => {
    const key = crypto.randomUUID();
    hold = gate();
    const first = post(app, { key });
    await sleep(900);
    const second = await post(app, { key });
    expect(second.status).toBe(409);
    hold.open();
    await first;
    expect(runs).toBe(1);
  });

  it("frees the key once nobody renews it", async () => {
    const key = crypto.randomUUID();
    await getRedis().set(
      recordKey(key),
      JSON.stringify({ state: "running", fingerprint: "x", owner: "gone" }),
      "PX",
      300,
    );
    await sleep(400);
    const res = await post(app, { key });
    expect(res.status).toBe(201);
    expect(runs).toBe(1);
  });

  it("does not overwrite a record another run took over, and logs it", async () => {
    const key = crypto.randomUUID();
    const error = vi.spyOn(logger, "error");
    hold = gate();
    const first = post(app, { key });
    await sleep(50);
    const taken = JSON.stringify({ state: "running", fingerprint: "y", owner: "other" });
    await getRedis().set(recordKey(key), taken, "PX", 5_000);
    hold.open();
    expect((await first).status).toBe(201);
    expect(await getRedis().get(recordKey(key))).toBe(taken);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-a", scope: "generate", key }),
      "idempotency_lease_lost",
    );
  });

  it("keeps renewing after one renewal fails, without crashing", async () => {
    const key = crypto.randomUUID();
    const redis = getRedis();
    const real = redis.eval.bind(redis);
    let failed = false;
    vi.spyOn(redis, "eval").mockImplementation(((...args: Parameters<typeof redis.eval>) => {
      if (!failed && String(args[0]).includes("pexpire")) {
        failed = true;
        return Promise.reject(new Error("Command timed out"));
      }
      return real(...args);
    }));
    hold = gate();
    const first = post(app, { key });
    await sleep(900);
    expect(failed).toBe(true);
    expect((await post(app, { key })).status).toBe(409);
    hold.open();
    expect((await first).status).toBe(201);
    expect(runs).toBe(1);
  });

  it("stops renewing and logs it once every renewal fails past the lease", async () => {
    const key = crypto.randomUUID();
    const redis = getRedis();
    const real = redis.eval.bind(redis);
    let renewals = 0;
    vi.spyOn(redis, "eval").mockImplementation(((...args: Parameters<typeof redis.eval>) => {
      if (String(args[0]).includes("pexpire")) {
        renewals += 1;
        return Promise.reject(new Error("Command timed out"));
      }
      return real(...args);
    }));
    const error = vi.spyOn(logger, "error");
    hold = gate();
    const first = post(app, { key });
    await sleep(600);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "generate" }),
      "idempotency_lease_expired",
    );
    const renewedBefore = renewals;
    await sleep(400);
    expect(renewals).toBe(renewedBefore);
    hold.open();
    expect((await first).status).toBe(201);
  });

  it("still answers when the finished answer cannot be stored", async () => {
    const key = crypto.randomUUID();
    const error = vi.spyOn(logger, "error");
    const redis = getRedis();
    const real = redis.eval.bind(redis);
    vi.spyOn(redis, "eval").mockImplementation(((...args: Parameters<typeof redis.eval>) => {
      if (String(args[0]).includes("'EX'")) return Promise.reject(new Error("READONLY"));
      return real(...args);
    }));
    const res = await post(app, { key });
    expect(res.status).toBe(201);
    expect(res.headers.get("Idempotency-Status")).toBe("done");
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-a", scope: "generate", key }),
      "idempotency_store_failed",
    );
  });

  it("writes done with the retention even when a renewal was in flight", async () => {
    const key = crypto.randomUUID();
    const redis = getRedis();
    const real = redis.eval.bind(redis);
    // The first renewal is held before it reaches Redis, so it is still in
    // flight when the handler finishes.
    const renewal = gate();
    let renewals = 0;
    vi.spyOn(redis, "eval").mockImplementation(((...args: Parameters<typeof redis.eval>) => {
      if (String(args[0]).includes("pexpire")) {
        renewals += 1;
        if (renewals === 1) return renewal.promise.then(() => real(...args));
      }
      return real(...args);
    }));
    const error = vi.spyOn(logger, "error");
    hold = gate();
    const first = post(app, { key });
    while (renewals === 0) await sleep(10);
    hold.open();
    await sleep(50);
    renewal.open();
    expect((await first).status).toBe(201);
    // Let the held renewal reach Redis before reading what it left behind.
    await sleep(100);
    const ttl = await getRedis().ttl(recordKey(key));
    expect(ttl).toBeGreaterThan(IDEMPOTENCY_RETENTION_SECONDS.generate - 5);
    expect(error).not.toHaveBeenCalled();
  });
});
