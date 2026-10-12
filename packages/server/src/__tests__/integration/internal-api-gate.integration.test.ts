// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The internal API's door (inner#1410 §4.1–§4.4, acceptance #1–#3): what a
 * request must get past before any handler runs, against real Postgres and
 * Redis over a real loopback socket.
 *
 * The order is rate limit (by connection address, fail closed) → signature
 * headers → ±300 s window → HMAC under either secret → nonce `SET NX EX 600`
 * (fail closed) → the authorisation table. Every refusal here must leave the
 * database and Stripe untouched: a refused request that wrote something is a
 * request that got in.
 *
 * Redis outages are injected at the one client the server shares
 * (`getRedis`), in the two shapes ioredis really produces: a pipeline whose
 * `exec()` resolves with per-command errors, and a command that rejects.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as BreaticCore from "@breatic/core";

type RedisFaultMode = "none" | "pipeline_error_results" | "pipeline_rejects" | "commands_reject";
const redisFault = vi.hoisted((): { mode: RedisFaultMode } => ({ mode: "none" }));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof BreaticCore>();
  /**
   * Wrap the real client so the current fault mode decides how it answers.
   * Pipelines are what the rate limiter sends; plain commands are what the
   * nonce step sends.
   * @param real - The real ioredis client.
   * @returns The wrapped client.
   */
  function faulty(real: ReturnType<typeof actual.getRedis>): ReturnType<typeof actual.getRedis> {
    return new Proxy(real, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value !== "function") return value;
        if (prop === "pipeline" || prop === "multi") {
          return (...args: unknown[]) => {
            const pipe = (value as (...a: unknown[]) => object).apply(target, args);
            const wrapped: object = new Proxy(pipe, {
              get(p, name, r) {
                const member = Reflect.get(p, name, r) as unknown;
                if (name === "exec") {
                  if (redisFault.mode === "pipeline_error_results") {
                    return async () => [
                      [new Error("WRONGTYPE synthetic"), null],
                      [new Error("WRONGTYPE synthetic"), null],
                      [new Error("WRONGTYPE synthetic"), null],
                      [new Error("WRONGTYPE synthetic"), null],
                    ];
                  }
                  if (redisFault.mode === "pipeline_rejects") {
                    return async () => {
                      throw new Error("Connection is closed.");
                    };
                  }
                }
                if (typeof member !== "function") return member;
                return (...a: unknown[]) => {
                  const out = (member as (...x: unknown[]) => unknown).apply(p, a);
                  return out === p ? wrapped : out;
                };
              },
            });
            return wrapped;
          };
        }
        if (redisFault.mode === "commands_reject") {
          return async () => {
            throw new Error("Connection is closed.");
          };
        }
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    });
  }
  return { ...actual, getRedis: () => faulty(actual.getRedis()) };
});

vi.mock("@server/infra/stripe.js", async () => {
  const { fakeStripe } = await import("./fake-stripe-refunds.js");
  return {
    getStripeClient: () => fakeStripe.client,
    verifyWebhookSignature: () => {
      throw new Error("not used by this suite");
    },
  };
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getRedis } from "@breatic/core";
import { getRateLimit } from "@server/config/rate-limits.js";
import { fakeStripe } from "./fake-stripe-refunds.js";
import {
  ADMIN,
  PREVIOUS_SECRET,
  SECRET,
  call,
  freshKey,
  freshNonce,
  mailsSettled,
  nonceKey,
  paths,
  useInternalApp,
} from "./internal-api-harness.js";
import { PAID_CENTS, seedRefundLot, worldOf } from "./credit-refund-fixtures.js";

// Registered before the suite's own hooks, so the fault mode is reset before
// the shared beforeEach clears the rate-limit keys through the same client.
beforeEach(() => {
  redisFault.mode = "none";
});
afterEach(() => {
  redisFault.mode = "none";
});

const suite = useInternalApp("internal-api-gate-test");
const running = {
  get baseUrl() {
    return suite.baseUrl;
  },
};
let sql: typeof suite.sql;
beforeAll(() => {
  sql = suite.sql;
});

/**
 * A lot waiting for a decision, known to the fake Stripe with no refunds.
 * @returns The seeded lot.
 */
async function pendingLot() {
  const lot = await seedRefundLot(sql, "refund_pending");
  fakeStripe.register(lot.paymentIntentId, PAID_CENTS);
  return lot;
}

const REJECT_BODY = { reason: "Buyer asked twice; policy says no." };

describe("signature (§4.2): each failed step is 401 and writes nothing", () => {
  const nowSeconds = () => Math.floor(Date.now() / 1000);

  // The timestamp rows are thunks: their offset must be taken when the request
  // is sent, not when the table is collected, because startup in between eats
  // into the 1-second margin past the 300-second window. The future row is
  // 302: both clocks are floored to whole seconds, so a second boundary
  // crossed between signing and checking turns +301 into +300 (accepted).
  type Opts = Parameters<typeof call>[2];
  const refusals: { name: string; opts: Opts | (() => Opts) }[] = [
    { name: "no signature headers at all", opts: { unsigned: true } },
    { name: "the signature header missing", opts: { headerOverrides: { "x-internal-signature": undefined } } },
    { name: "the admin id outside [A-Za-z0-9_-]", opts: { admin: "admin 7" } },
    { name: "an admin id longer than 64 characters", opts: { admin: "a".repeat(65) } },
    { name: "a nonce shorter than 16 characters", opts: { nonce: "abcdefghijklmno" } },
    { name: "a timestamp that is not Unix seconds", opts: { headerOverrides: { "x-internal-timestamp": "2026-10-12T00:00:00Z" } } },
    { name: "a signature without the v1= prefix", opts: { headerOverrides: { "x-internal-signature": "a".repeat(64) } } },
    { name: "a timestamp 301 seconds in the past", opts: () => ({ timestamp: nowSeconds() - 301 }) },
    { name: "a timestamp 302 seconds in the future", opts: () => ({ timestamp: nowSeconds() + 302 }) },
    { name: "a signature made with an unknown secret", opts: { secret: "not-the-shared-secret-at-all-0000" } },
    { name: "a body changed after signing", opts: { signedBody: JSON.stringify({ reason: "something else" }) } },
    { name: "an idempotency key changed after signing", opts: { signedIdempotencyKey: "bo-op-the-signed-one" } },
    { name: "an admin id changed after signing", opts: { headerOverrides: { "x-internal-admin": "admin_8" } } },
  ];

  it.each(refusals)("refuses $name", async ({ opts }) => {
    const lot = await pendingLot();
    const before = await worldOf(sql, lot);

    const res = await call(running.baseUrl, paths.reject(lot.lotId), {
      body: REJECT_BODY,
      idempotencyKey: freshKey("reject"),
      ...(typeof opts === "function" ? opts() : opts),
    });

    expect(res.status).toBe(401);
    expect(res.json).toEqual({ code: "unauthorized" });
    expect(await worldOf(sql, lot)).toEqual(before);
    expect(fakeStripe.listCalls).toEqual([]);
    expect(fakeStripe.createCalls).toEqual([]);
  });

  it("refuses a replayed nonce even when everything else is identical, and the first request's effects stay single", async () => {
    const lot = await pendingLot();
    const first = await call(running.baseUrl, paths.reject(lot.lotId), {
      body: REJECT_BODY,
      idempotencyKey: freshKey("reject"),
    });
    expect(first.status).toBe(200);
    expect(first.json.result).toBe("rejected");
    await mailsSettled(sql, lot);
    const after = await worldOf(sql, lot);

    const again = await first.replay();

    expect(again.status).toBe(401);
    expect(again.json).toEqual({ code: "unauthorized" });
    expect(await worldOf(sql, lot)).toEqual(after);
    expect(after.ops).toHaveLength(1);
    expect(fakeStripe.listCalls).toHaveLength(1);
  });

  it("stores the nonce under {env}:server:internal-nonce:<nonce> for 600 seconds", async () => {
    const lot = await pendingLot();
    const nonce = freshNonce();

    const res = await call(running.baseUrl, paths.preview(lot.lotId), { nonce });

    expect(res.status).toBe(200);
    const ttl = await getRedis().ttl(nonceKey(nonce));
    expect(ttl).toBeGreaterThan(590);
    expect(ttl).toBeLessThanOrEqual(600);
  });

  it("accepts a request signed with the previous secret during rotation", async () => {
    const lot = await pendingLot();

    const res = await call(running.baseUrl, paths.reject(lot.lotId), {
      body: REJECT_BODY,
      idempotencyKey: freshKey("reject"),
      secret: PREVIOUS_SECRET,
    });

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ lotId: lot.lotId, kind: "reject", status: "succeeded", result: "rejected", requestedBy: ADMIN });
  });

  it("the honest request every refusal above was built from is accepted", async () => {
    const lot = await pendingLot();

    const res = await call(running.baseUrl, paths.reject(lot.lotId), {
      body: REJECT_BODY,
      idempotencyKey: freshKey("reject"),
      secret: SECRET,
    });

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ kind: "reject", status: "succeeded", result: "rejected" });
  });
});

describe("Redis unavailable is 503, never let through (§4.2, §4.4)", () => {
  it("the rate-limit step answers 503 unavailable when the pipeline resolves with per-command errors — before the signature is even read", async () => {
    const lot = await pendingLot();
    const before = await worldOf(sql, lot);
    redisFault.mode = "pipeline_error_results";

    const signed = await call(running.baseUrl, paths.reject(lot.lotId), {
      body: REJECT_BODY,
      idempotencyKey: freshKey("reject"),
    });
    const unsigned = await call(running.baseUrl, paths.reject(lot.lotId), { body: REJECT_BODY, unsigned: true });

    expect(signed.status).toBe(503);
    expect(signed.json).toEqual({ code: "unavailable" });
    expect(unsigned.status).toBe(503);
    expect(unsigned.json).toEqual({ code: "unavailable" });
    expect(await worldOf(sql, lot)).toEqual(before);
    expect(fakeStripe.listCalls).toEqual([]);
  });

  it("the rate-limit step answers 503 unavailable when the connection itself throws", async () => {
    const lot = await pendingLot();
    const before = await worldOf(sql, lot);
    redisFault.mode = "pipeline_rejects";

    const res = await call(running.baseUrl, paths.reject(lot.lotId), {
      body: REJECT_BODY,
      idempotencyKey: freshKey("reject"),
    });

    expect(res.status).toBe(503);
    expect(res.json).toEqual({ code: "unavailable" });
    expect(await worldOf(sql, lot)).toEqual(before);
    expect(fakeStripe.listCalls).toEqual([]);
  });

  it("the nonce step answers 503 unavailable when SET fails, writes nothing, and the same signed bytes go through once Redis is back", async () => {
    const lot = await pendingLot();
    const before = await worldOf(sql, lot);
    redisFault.mode = "commands_reject";

    const res = await call(running.baseUrl, paths.reject(lot.lotId), {
      body: REJECT_BODY,
      idempotencyKey: freshKey("reject"),
    });

    expect(res.status).toBe(503);
    expect(res.json).toEqual({ code: "unavailable" });
    expect(await worldOf(sql, lot)).toEqual(before);
    expect(fakeStripe.listCalls).toEqual([]);

    redisFault.mode = "none";
    const retried = await res.replay();
    expect(retried.status).toBe(200);
    expect(retried.json).toMatchObject({ kind: "reject", result: "rejected" });
  });

  it("an unsigned request while only the nonce store is down is still 401, not 503: the nonce step comes after the HMAC", async () => {
    redisFault.mode = "commands_reject";

    const res = await call(running.baseUrl, paths.preview("00000000-0000-4000-8000-000000000000"), { unsigned: true });

    expect(res.status).toBe(401);
    expect(res.json).toEqual({ code: "unauthorized" });
  });
});

describe("authorisation table (§4.3)", () => {
  it.each([
    ["GET", "/internal/v1/health"],
    ["POST", "/internal/v1/credit-lots/00000000-0000-4000-8000-000000000000/refund/delete"],
    ["GET", "/internal/v1/credit-lots/00000000-0000-4000-8000-000000000000/refund/approve"],
    ["POST", "/internal/v2/credit-lots/00000000-0000-4000-8000-000000000000/refund/approve"],
    ["GET", "/api/v1/credits/lots"],
  ] as const)("a correctly signed %s %s that is not in the table is 403 forbidden", async (method, path) => {
    const res = await call(running.baseUrl, path, {
      method,
      ...(method === "POST" ? { body: { reason: "probe" }, idempotencyKey: freshKey("probe") } : {}),
    });

    expect(res.status).toBe(403);
    expect(res.json).toEqual({ code: "forbidden" });
    expect(fakeStripe.listCalls).toEqual([]);
  });

  it("registers exactly the nine endpoints of §4.5, by method and path template", async () => {
    const { createInternalApp } = await import("@server/internal-app.js");
    const registered = createInternalApp()
      .routes.filter((r) => r.method !== "ALL")
      .map((r) => `${r.method} ${r.path}`)
      .sort();

    expect(registered).toEqual(
      [
        "GET /internal/v1/credit-lots/:lotId/refund",
        "POST /internal/v1/credit-lots/:lotId/refund/approve",
        "POST /internal/v1/credit-lots/:lotId/refund/reject",
        "POST /internal/v1/credit-lots/:lotId/refund/settle",
        "POST /internal/v1/credit-lots/:lotId/refund/send-back",
        "POST /internal/v1/credit-lots/:lotId/refund/retry",
        "POST /internal/v1/credit-lots/:lotId/refund/refund-again",
        "POST /internal/v1/credit-lots/:lotId/refund/resolved-outside",
        "POST /internal/v1/refund-operations/:operationId/mail/resend",
      ].sort(),
    );
  });
});

describe("rate limit by connection address (§4.4)", () => {
  it("answers 429 { code: rate_limited } with Retry-After once the window's budget is spent, counting unsigned requests too", async () => {
    const { max, windowSeconds } = getRateLimit("internal-api");
    const probe = paths.preview("00000000-0000-4000-8000-000000000000");

    for (let i = 0; i < max; i += 1) {
      const res = await call(running.baseUrl, probe, { unsigned: true });
      expect(res.status).toBe(401);
    }
    const limited = await call(running.baseUrl, probe);

    expect(limited.status).toBe(429);
    expect(limited.json).toEqual({ code: "rate_limited" });
    const retryAfter = Number(limited.headers.get("retry-after"));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(windowSeconds);
  });

  it("the configured budget is the one the design sets: 120 per 60 seconds", () => {
    expect(getRateLimit("internal-api")).toEqual({ max: 120, windowSeconds: 60 });
  });
});

describe("the public app has no internal surface (§4.1, acceptance #1)", () => {
  it("createApp registers no route containing /internal and answers 404 for the internal paths", async () => {
    const { createApp } = await import("@server/app.js");
    const app = createApp();

    expect(app.routes.filter((r) => r.path.includes("internal"))).toEqual([]);
    const direct = await app.request("/internal/v1/credit-lots/00000000-0000-4000-8000-000000000000/refund");
    const underApi = await app.request("/api/v1/internal/v1/credit-lots/00000000-0000-4000-8000-000000000000/refund");
    expect(direct.status).toBe(404);
    expect(underApi.status).toBe(404);
  });

  it("app.ts does not import the internal app", () => {
    const source = readFileSync(resolve(__dirname, "../../app.ts"), "utf8");

    expect(source).not.toMatch(/internal-app/);
    expect(source).not.toMatch(/routes\/internal/);
  });
});
