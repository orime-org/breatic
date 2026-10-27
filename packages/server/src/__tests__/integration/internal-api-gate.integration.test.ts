// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The internal API's door (inner#1410 §4.1–§4.4, acceptance #1–#3): what a
 * request must get past before any handler runs, against real Postgres and
 * Redis over a real loopback socket.
 *
 * The order is rate limit (by connection address, fail closed) → body size
 * (64 KiB, 413) → signature headers → ±300 s window → HMAC under either
 * secret → nonce `SET NX EX 602` (fail closed) → the authorisation table.
 * Every refusal here must leave the database and Stripe untouched: a refused
 * request that wrote something is a request that got in. Every request, let
 * through or refused, logs one `internal_api_request` line (acceptance #14).
 *
 * Redis outages are injected at the one client the server shares
 * (`getRedis`), one step at a time: the rate limiter's `EVAL` rejects, or
 * every other command (the nonce step's `SET`) rejects.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as BreaticCore from "@breatic/core";

type RedisFaultMode = "none" | "limiter_rejects" | "commands_reject";
const redisFault = vi.hoisted((): { mode: RedisFaultMode } => ({ mode: "none" }));
const logged = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof BreaticCore>();
  /**
   * Wrap the real client so the current fault mode decides how it answers.
   * `eval` is what the rate limiter sends; every other command is the nonce
   * step's.
   * @param real - The real ioredis client.
   * @returns The wrapped client.
   */
  function faulty(real: ReturnType<typeof actual.getRedis>): ReturnType<typeof actual.getRedis> {
    return new Proxy(real, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value !== "function") return value;
        const isLimiter = prop === "eval";
        if ((redisFault.mode === "limiter_rejects" && isLimiter) || (redisFault.mode === "commands_reject" && !isLimiter)) {
          return async () => {
            throw new Error("Connection is closed.");
          };
        }
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    });
  }
  // `info` and `warn` are recorded instead of written; every other level goes to the real logger.
  const logger = new Proxy(actual.logger, {
    get: (target, prop) => (prop === "info" ? logged.info : prop === "warn" ? logged.warn : Reflect.get(target, prop)),
  });
  return { ...actual, getRedis: () => faulty(actual.getRedis()), logger };
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

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getRedis } from "@breatic/core";
import { t } from "@breatic/shared";
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
import { PAID_CENTS, reId, refundObject, seedRefundLot, worldOf } from "./credit-refund-fixtures.js";

// Registered before the suite's own hooks, so the fault mode is reset before
// the shared beforeEach clears the rate-limit keys through the same client.
beforeEach(() => {
  redisFault.mode = "none";
  logged.info.mockClear();
  logged.warn.mockClear();
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
const ENTERPRISE_BODY = {
  targetTier: "enterprise",
  expiresAt: "2099-10-26T00:00:00.000Z",
  entryTimezone: "UTC",
  contractNumber: "GATE-ENTERPRISE",
  limits: { team_studios: 8, projects_per_studio: 500, concurrent_editors: 30, studio_members: 200, project_members: 80, storage_bytes: 1099511627776 },
  expectedRevision: null,
  expectedStoredTier: "pro",
};

/**
 * The enterprise profile and write path for one account.
 * @param userId - The account under test.
 * @returns Its internal path.
 */
function enterprisePath(userId: string): string {
  return `/internal/v1/accounts/${userId}/enterprise-membership`;
}

/**
 * The enterprise operation lookup path for one request.
 * @param key - The immutable request key.
 * @returns Its internal path.
 */
function enterpriseOperationPath(key: string): string {
  return `/internal/v1/enterprise-membership-operations/${key}`;
}

/**
 * Create a real account so a mistakenly admitted write could change it.
 * @returns The account id.
 */
async function enterpriseAccount(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, membership_tier) VALUES (${`${randomUUID()}@example.test`}, 'pro') RETURNING id
  `;
  return row!.id;
}

/**
 * A refusal must leave the account, membership, operation and tier history untouched.
 * @param userId - The account under test.
 * @param key - The request key that must not have been claimed.
 */
async function expectEnterpriseUntouched(userId: string, key: string): Promise<void> {
  expect(await sql`SELECT membership_tier FROM users WHERE id = ${userId}`).toEqual([{ membership_tier: "pro" }]);
  expect(await sql`SELECT user_id FROM enterprise_memberships WHERE user_id = ${userId}`).toEqual([]);
  expect(await sql`SELECT key FROM enterprise_membership_operations WHERE target_user_id = ${userId} OR key = ${key}`).toEqual([]);
  expect(await sql`SELECT id FROM membership_tier_changes WHERE user_id = ${userId}`).toEqual([]);
  expect(fakeStripe.listCalls).toEqual([]);
  expect(fakeStripe.createCalls).toEqual([]);
}

/**
 * The fields of every line logged at one level under one message.
 * @param level - The recorded level.
 * @param message - The line's message.
 * @returns Their field objects, in order.
 */
function linesOf(level: "info" | "warn", message: string): Record<string, unknown>[] {
  return logged[level].mock.calls
    .filter((args: unknown[]) => args[1] === message)
    .map((args: unknown[]) => args[0] as Record<string, unknown>);
}

/**
 * Check a 401 left exactly one `internal_auth_rejected` line naming the step
 * that refused it, besides its one `internal_api_request` line (acceptance #2).
 * @param step - The refusing step.
 * @param path - The request's path.
 */
async function expectOneRejectionLine(step: "headers" | "timestamp" | "signature" | "nonce", path: string): Promise<void> {
  await vi.waitFor(() => expect(linesOf("info", "internal_api_request").length).toBeGreaterThan(0), {
    timeout: 2_000,
    interval: 10,
  });
  const requests = linesOf("info", "internal_api_request");
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ path, status: 401, code: "unauthorized" });
  const rejections = linesOf("warn", "internal_auth_rejected");
  expect(rejections).toHaveLength(1);
  expect(rejections[0]).toMatchObject({ step, path });
}

describe("signature (§4.2): each failed step is 401 and writes nothing", () => {
  const nowSeconds = () => Math.floor(Date.now() / 1000);

  // The timestamp rows are thunks: their offset must be taken when the request
  // is sent, not when the table is collected, because startup in between eats
  // into the 1-second margin past the 300-second window. The future row is
  // 302: both clocks are floored to whole seconds, so a second boundary
  // crossed between signing and checking turns +301 into +300 (accepted).
  type Opts = Parameters<typeof call>[2];
  const refusals: { name: string; step: "headers" | "timestamp" | "signature"; opts: Opts | (() => Opts) }[] = [
    { name: "no signature headers at all", step: "headers", opts: { unsigned: true } },
    { name: "the signature header missing", step: "headers", opts: { headerOverrides: { "x-internal-signature": undefined } } },
    { name: "the admin id outside [A-Za-z0-9_-]", step: "headers", opts: { admin: "admin 7" } },
    { name: "an admin id longer than 64 characters", step: "headers", opts: { admin: "a".repeat(65) } },
    { name: "a nonce shorter than 16 characters", step: "headers", opts: { nonce: "abcdefghijklmno" } },
    { name: "a timestamp that is not Unix seconds", step: "headers", opts: { headerOverrides: { "x-internal-timestamp": "2026-10-12T00:00:00Z" } } },
    { name: "a signature without the v1= prefix", step: "headers", opts: { headerOverrides: { "x-internal-signature": "a".repeat(64) } } },
    { name: "a timestamp 301 seconds in the past", step: "timestamp", opts: () => ({ timestamp: nowSeconds() - 301 }) },
    { name: "a timestamp 302 seconds in the future", step: "timestamp", opts: () => ({ timestamp: nowSeconds() + 302 }) },
    { name: "a signature made with an unknown secret", step: "signature", opts: { secret: "not-the-shared-secret-at-all-0000" } },
    { name: "a body changed after signing", step: "signature", opts: { signedBody: JSON.stringify({ reason: "something else" }) } },
    { name: "an idempotency key changed after signing", step: "signature", opts: { signedIdempotencyKey: "bo-op-the-signed-one" } },
    { name: "an admin id changed after signing", step: "signature", opts: { headerOverrides: { "x-internal-admin": "admin_8" } } },
  ];

  it.each(refusals)("refuses $name at the $step step", async ({ step, opts }) => {
    const lot = await pendingLot();
    const before = await worldOf(sql, lot);
    const resolved = { nonce: freshNonce(), ...(typeof opts === "function" ? opts() : opts) };

    const res = await call(running.baseUrl, paths.reject(lot.lotId), {
      body: REJECT_BODY,
      idempotencyKey: freshKey("reject"),
      ...resolved,
    });

    expect(res.status).toBe(401);
    expect(res.json).toEqual({ code: "unauthorized" });
    expect(await worldOf(sql, lot)).toEqual(before);
    expect(fakeStripe.listCalls).toEqual([]);
    expect(fakeStripe.createCalls).toEqual([]);
    await expectOneRejectionLine(step, paths.reject(lot.lotId));
    // Every step here comes before the nonce's SET, so the nonce stays unspent.
    expect(await getRedis().exists(nonceKey(resolved.nonce))).toBe(0);
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
    await vi.waitFor(() => expect(linesOf("info", "internal_api_request")).toHaveLength(1), { timeout: 2_000, interval: 10 });
    logged.info.mockClear();
    logged.warn.mockClear();

    const again = await first.replay();

    expect(again.status).toBe(401);
    expect(again.json).toEqual({ code: "unauthorized" });
    expect(await worldOf(sql, lot)).toEqual(after);
    expect(after.ops).toHaveLength(1);
    expect(fakeStripe.listCalls).toHaveLength(1);
    await expectOneRejectionLine("nonce", paths.reject(lot.lotId));
  });

  // The window is inclusive on floored seconds, so a timestamp S is accepted
  // over real time [S-300, S+301): 601 seconds, plus one for the floor of the
  // moment the key is set. The key was set between `sent` and the read, so
  // what is left plus what has passed is at least the full TTL.
  it("stores the nonce under {env}:server:internal-nonce:<nonce> for 602 seconds", async () => {
    const lot = await pendingLot();
    const nonce = freshNonce();
    const sent = Date.now();

    const res = await call(running.baseUrl, paths.preview(lot.lotId), { nonce });

    expect(res.status).toBe(200);
    const leftMs = await getRedis().pttl(nonceKey(nonce));
    const passedMs = Date.now() - sent;
    expect(leftMs).toBeLessThanOrEqual(602_000);
    expect(leftMs + passedMs).toBeGreaterThanOrEqual(602_000);
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
  it("the rate-limit step answers 503 unavailable when Redis cannot count — before the signature is even read", async () => {
    const lot = await pendingLot();
    const before = await worldOf(sql, lot);
    redisFault.mode = "limiter_rejects";

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

describe("enterprise endpoints use the shared signature gate", () => {
  it.each([
    ["GET", "profile", "unsigned"],
    ["GET", "profile", "wrong signature"],
    ["GET", "operation", "unsigned"],
    ["GET", "operation", "wrong signature"],
    ["POST", "profile", "unsigned"],
    ["POST", "profile", "wrong signature"],
  ] as const)("%s %s refuses %s without changing membership", async (method, target, authentication) => {
    const userId = await enterpriseAccount();
    const key = `bo-${randomUUID()}`;
    const path = target === "operation" ? enterpriseOperationPath(key) : enterprisePath(userId);
    const res = await call(running.baseUrl, path, {
      method,
      ...(method === "POST" ? { body: ENTERPRISE_BODY, idempotencyKey: key } : {}),
      ...(authentication === "unsigned" ? { unsigned: true } : { secret: "not-the-shared-secret-at-all-0000" }),
    });

    expect(res.status).toBe(401);
    expect(res.json).toEqual({ code: "unauthorized" });
    await expectEnterpriseUntouched(userId, key);
  });
});

describe("authorisation table (§4.3)", () => {
  it.each([
    ["GET", "/internal/v1/health"],
    ["POST", "/internal/v1/credit-lots/00000000-0000-4000-8000-000000000000/refund/delete"],
    ["GET", "/internal/v1/credit-lots/00000000-0000-4000-8000-000000000000/refund/approve"],
    ["POST", "/internal/v2/credit-lots/00000000-0000-4000-8000-000000000000/refund/approve"],
    // v9 removed refund-again: it is no longer in the table.
    ["POST", "/internal/v1/credit-lots/00000000-0000-4000-8000-000000000000/refund/refund-again"],
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

  // A route that mounts `validate()` before its handler is listed once per
  // handler, so the table is compared as a set of method and path.
  it("registers exactly the approved refund and enterprise endpoints, by method and path template", async () => {
    const { createInternalApp } = await import("@server/internal-app.js");
    const registered = [
      ...new Set(
        createInternalApp()
          .routes.filter((r) => r.method !== "ALL")
          .map((r) => `${r.method} ${r.path}`),
      ),
    ].sort();

    expect(registered).toEqual(
      [
        "GET /internal/v1/credit-lots/:lotId/refund",
        "POST /internal/v1/credit-lots/:lotId/refund/approve",
        "POST /internal/v1/credit-lots/:lotId/refund/reject",
        "POST /internal/v1/credit-lots/:lotId/refund/settle",
        "POST /internal/v1/credit-lots/:lotId/refund/send-back",
        "POST /internal/v1/credit-lots/:lotId/refund/retry",
        "POST /internal/v1/credit-lots/:lotId/refund/resolved-outside",
        "POST /internal/v1/credit-lots/:lotId/refund/restore-credits",
        "POST /internal/v1/refund-operations/:operationId/mail/resend",
        "GET /internal/v1/accounts/:userId/enterprise-membership",
        "GET /internal/v1/enterprise-membership-operations/:key",
        "POST /internal/v1/accounts/:userId/enterprise-membership",
      ].sort(),
    );
  });

  it.each([
    ["PUT", "profile"],
    ["DELETE", "profile"],
    ["POST", "operation"],
    ["GET", "wrong version"],
    ["POST", "similar path"],
    ["HEAD", "profile"],
    ["HEAD", "operation"],
  ] as const)("a signed %s on the enterprise %s path is forbidden", async (method, target) => {
    const userId = await enterpriseAccount();
    const key = `bo-${randomUUID()}`;
    let path = enterprisePath(userId);
    if (target === "operation") path = enterpriseOperationPath(key);
    if (target === "wrong version") path = path.replace("/v1/", "/v2/");
    if (target === "similar path") path = `${path}/delete`;
    const res = await call(running.baseUrl, path, {
      // The harness signs any method; its public type lists the allowed ones.
      method: method as "GET" | "POST",
      ...(["POST", "PUT", "DELETE"].includes(method) ? { body: ENTERPRISE_BODY, idempotencyKey: key } : {}),
    });

    expect(res.status).toBe(403);
    if (method === "HEAD") expect(res.json).toBeNull();
    else expect(res.json).toEqual({ code: "forbidden" });
    await expectEnterpriseUntouched(userId, key);
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

  it.each([
    ["GET", "profile"],
    ["GET", "operation"],
    ["POST", "profile"],
  ] as const)("the public app answers 404 for enterprise %s %s directly and under /api/v1", async (method, target) => {
    const { createApp } = await import("@server/app.js");
    const app = createApp();
    const userId = await enterpriseAccount();
    const key = `bo-${randomUUID()}`;
    const path = target === "operation" ? enterpriseOperationPath(key) : enterprisePath(userId);

    for (const publicPath of [path, `/api/v1${path}`]) {
      const res = await app.request(publicPath, {
        method,
        ...(method === "POST" ? { headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(ENTERPRISE_BODY) } : {}),
      });
      expect(res.status).toBe(404);
    }
    await expectEnterpriseUntouched(userId, key);
  });
});

describe("request body size (§4.6): over 64 KiB is 413 before the signature is read", () => {
  /** 64 KiB plus one byte of well-formed JSON. */
  const OVERSIZE = `{"reason":"${"x".repeat(64 * 1024 + 1 - '{"reason":""}'.length)}"}`;
  const NO_LOT = "00000000-0000-4000-8000-000000000000";

  it("the oversize body is exactly 65537 bytes", () => {
    expect(Buffer.byteLength(OVERSIZE)).toBe(65_537);
  });

  it.each([
    ["an approval", paths.approve(NO_LOT)],
    ["a rejection", paths.reject(NO_LOT)],
    ["a mail resend", paths.resend(NO_LOT)],
    ["a path outside the table", "/internal/v1/health"],
  ])("an unsigned oversize POST to %s is 413 invalid_body", async (_name, path) => {
    const res = await call(running.baseUrl, path, { rawBody: OVERSIZE, unsigned: true });

    expect(res.status).toBe(413);
    expect(res.json).toEqual({ code: "invalid_body" });
  });

  it("a correctly signed oversize body is 413 too, writes no nonce and touches nothing", async () => {
    const lot = await pendingLot();
    const before = await worldOf(sql, lot);
    const nonce = freshNonce();

    const res = await call(running.baseUrl, paths.reject(lot.lotId), {
      rawBody: OVERSIZE,
      idempotencyKey: freshKey("reject"),
      nonce,
    });

    expect(res.status).toBe(413);
    expect(res.json).toEqual({ code: "invalid_body" });
    expect(await getRedis().exists(nonceKey(nonce))).toBe(0);
    expect(await worldOf(sql, lot)).toEqual(before);
    expect(fakeStripe.listCalls).toEqual([]);
  });

  it.each([true, false])("an enterprise oversize POST is 413 before authentication (unsigned=%s) and writes nothing", async (unsigned) => {
    const userId = await enterpriseAccount();
    const key = `bo-${randomUUID()}`;
    const nonce = freshNonce();
    const res = await call(running.baseUrl, enterprisePath(userId), {
      rawBody: OVERSIZE,
      idempotencyKey: key,
      nonce,
      unsigned,
    });

    expect(res.status).toBe(413);
    expect(res.json).toEqual({ code: "invalid_body" });
    expect(await getRedis().exists(nonceKey(nonce))).toBe(0);
    await expectEnterpriseUntouched(userId, key);
  });

  // The largest honest body: a 500-character reason and 100 refund ids of 255
  // characters each, about 26 KB. The limit must leave it room.
  it("a signed body of the largest honest size gets past the gate", async () => {
    const lot = await pendingLot();
    const confirmedRefundIds = Array.from({ length: 100 }, (_, i) => `re_${String(i).padStart(3, "0")}${"x".repeat(249)}`);
    const rawBody = JSON.stringify({ reason: "r".repeat(500), confirmedRefundIds });
    expect(Buffer.byteLength(rawBody)).toBeGreaterThan(26_000);

    const res = await call(running.baseUrl, paths.approve(lot.lotId), { rawBody, idempotencyKey: freshKey("approve") });

    expect(res.status).not.toBe(413);
    expect(res.status).not.toBe(401);
    expect(res.json?.code).not.toBe("invalid_body");
  });
});

describe("body contract of every write endpoint (§4.5, §4.6)", () => {
  const NO_LOT = "00000000-0000-4000-8000-000000000000";
  const writes = [
    ["approve", paths.approve(NO_LOT)],
    ["reject", paths.reject(NO_LOT)],
    ["settle", paths.settle(NO_LOT)],
    ["send-back", paths.sendBack(NO_LOT)],
    ["retry", paths.retry(NO_LOT)],
    ["resolved-outside", paths.resolvedOutside(NO_LOT)],
    ["restore-credits", paths.restoreCredits(NO_LOT)],
    ["mail resend", paths.resend(NO_LOT)],
  ] as const;

  it.each(writes)("%s: a body that is not JSON is 400 invalid_body", async (_name, path) => {
    const res = await call(running.baseUrl, path, { rawBody: "{ not json", idempotencyKey: freshKey("bad") });

    expect(res.status).toBe(400);
    expect(res.json.code).toBe("invalid_body");
    expect(fakeStripe.listCalls).toEqual([]);
  });

  // The detail is the internal API's own sentence, not the public app's
  // "Invalid input" that validate() throws with (§4.6).
  it.each(writes)("%s: a JSON body that fails the schema is 422 invalid_body with the server.internal.invalid_body sentence", async (_name, path) => {
    const res = await call(running.baseUrl, path, { body: { unexpected: true }, idempotencyKey: freshKey("bad") });

    expect(res.status).toBe(422);
    expect(res.json).toEqual({ code: "invalid_body", detail: t("server.internal.invalid_body") });
    expect(res.json.detail).not.toBe(t("server.error.validation"));
    expect(fakeStripe.listCalls).toEqual([]);
  });

  it.each([
    { name: "malformed JSON", rawBody: "{ not json", status: 400 },
    { name: "a body outside the schema", rawBody: JSON.stringify({ unexpected: true }), status: 422 },
  ] as const)("enterprise: $name is $status invalid_body and writes nothing", async ({ rawBody, status }) => {
    const userId = await enterpriseAccount();
    const key = `bo-${randomUUID()}`;
    const res = await call(running.baseUrl, enterprisePath(userId), { rawBody, idempotencyKey: key });

    expect(res.status).toBe(status);
    expect(res.json.code).toBe("invalid_body");
    if (status === 422) expect(res.json.detail).toBe(t("server.internal.invalid_body"));
    await expectEnterpriseUntouched(userId, key);
  });

  // Whatever maps the schema failure to the internal sentence must leave the
  // key check's own sentence alone.
  it("a valid body with a malformed idempotency key is 422 invalid_body with the server.internal.invalid_idempotency_key sentence", async () => {
    const lot = await pendingLot();
    const before = await worldOf(sql, lot);

    const res = await call(running.baseUrl, paths.reject(lot.lotId), { body: REJECT_BODY, idempotencyKey: "has a space" });

    expect(res.status).toBe(422);
    expect(res.json).toEqual({ code: "invalid_body", detail: t("server.internal.invalid_idempotency_key") });
    expect(await worldOf(sql, lot)).toEqual(before);
  });
});

describe("one structured log line per request (acceptance #14)", () => {
  /**
   * The `internal_api_request` lines logged since the case began.
   * @returns Their field objects, in order.
   */
  function requestLines(): Record<string, unknown>[] {
    return logged.info.mock.calls
      .filter((args: unknown[]) => args[1] === "internal_api_request")
      .map((args: unknown[]) => args[0] as Record<string, unknown>);
  }

  /**
   * Wait for the request's line and check it is the only one.
   * @returns Its fields.
   */
  async function theOneLine(): Promise<Record<string, unknown>> {
    await vi.waitFor(() => expect(requestLines().length).toBeGreaterThan(0), { timeout: 2_000, interval: 10 });
    const lines = requestLines();
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(typeof line["durationMs"]).toBe("number");
    expect(line["durationMs"]).toBeGreaterThanOrEqual(0);
    return line;
  }

  it("an accepted write logs who, what, which key and the status", async () => {
    const lot = await pendingLot();
    const key = freshKey("reject");

    const res = await call(running.baseUrl, paths.reject(lot.lotId), { body: REJECT_BODY, idempotencyKey: key });
    await mailsSettled(sql, lot);

    expect(res.status).toBe(200);
    const line = await theOneLine();
    expect(line).toMatchObject({
      adminId: ADMIN,
      method: "POST",
      path: paths.reject(lot.lotId),
      idempotencyKey: key,
      status: 200,
      reason: REJECT_BODY.reason,
    });
    expect(line["code"]).toBeUndefined();
  });

  it("an accepted read logs no idempotency key, no reason and no code", async () => {
    const lot = await pendingLot();

    const res = await call(running.baseUrl, `${paths.preview(lot.lotId)}?probe=1`);

    expect(res.status).toBe(200);
    const line = await theOneLine();
    expect(line).toMatchObject({ adminId: ADMIN, method: "GET", path: paths.preview(lot.lotId), status: 200 });
    expect(line["idempotencyKey"]).toBeUndefined();
    expect(line["reason"]).toBeUndefined();
    expect(line["code"]).toBeUndefined();
  });

  it("an unsigned request is 401 and its line names no admin and no reason, and carries code unauthorized", async () => {
    const key = freshKey("reject");
    const path = paths.reject("00000000-0000-4000-8000-000000000000");

    const res = await call(running.baseUrl, path, { body: REJECT_BODY, idempotencyKey: key, unsigned: true });

    expect(res.status).toBe(401);
    const line = await theOneLine();
    expect(line).toMatchObject({ method: "POST", path, idempotencyKey: key, status: 401, code: "unauthorized" });
    expect(line["adminId"]).toBeUndefined();
    expect(line["reason"]).toBeUndefined();
  });

  it("a signed request outside the table is 403 and still logged with code forbidden", async () => {
    const key = freshKey("probe");

    const res = await call(running.baseUrl, "/internal/v1/health", { body: { reason: "probe" }, idempotencyKey: key });

    expect(res.status).toBe(403);
    expect(await theOneLine()).toMatchObject({
      adminId: ADMIN,
      method: "POST",
      path: "/internal/v1/health",
      idempotencyKey: key,
      status: 403,
      code: "forbidden",
    });
  });

  // Hono answers HEAD with the GET route of the same path, so a HEAD on the
  // preview path would run the preview (a Stripe read that writes copies).
  // HEAD is in no row of the table, so it is 403 like any other undeclared
  // pair. A HEAD answer carries no body on the wire; the line's code is the
  // body's code.
  it("a signed HEAD on the preview path is 403, runs no preview and is logged with code forbidden", async () => {
    const lot = await pendingLot();
    const before = await worldOf(sql, lot);

    // `call` types only the methods the table uses; HEAD is signed the same way.
    const res = await call(running.baseUrl, paths.preview(lot.lotId), { method: "HEAD" as unknown as "GET" });

    expect(res.status).toBe(403);
    expect(fakeStripe.listCalls).toEqual([]);
    expect(await worldOf(sql, lot)).toEqual(before);
    expect(await theOneLine()).toMatchObject({
      adminId: ADMIN,
      method: "HEAD",
      path: paths.preview(lot.lotId),
      status: 403,
      code: "forbidden",
    });
  });

  it("a write refused at a precondition is 409 and still logged with its reason and code lot_state_changed", async () => {
    const lot = await seedRefundLot(sql, "active");
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS);
    const key = freshKey("reject");

    const res = await call(running.baseUrl, paths.reject(lot.lotId), { body: REJECT_BODY, idempotencyKey: key });

    expect(res.status).toBe(409);
    expect(await theOneLine()).toMatchObject({
      adminId: ADMIN,
      method: "POST",
      path: paths.reject(lot.lotId),
      idempotencyKey: key,
      status: 409,
      reason: REJECT_BODY.reason,
      code: "lot_state_changed",
    });
  });

  // A refused write stores nothing (§4.6), so this line is the only place
  // the operator's reason and the refusal's code are kept.
  it("a write Stripe blocks is 409 and logged with its reason and code stripe_blocks", async () => {
    const lot = await seedRefundLot(sql, "refund_pending");
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(reId("x"), "pending", 300)]);
    const key = freshKey("reject");

    const res = await call(running.baseUrl, paths.reject(lot.lotId), { body: REJECT_BODY, idempotencyKey: key });

    expect(res.status).toBe(409);
    expect(res.json.code).toBe("stripe_blocks");
    expect(await theOneLine()).toMatchObject({
      adminId: ADMIN,
      method: "POST",
      path: paths.reject(lot.lotId),
      idempotencyKey: key,
      status: 409,
      reason: REJECT_BODY.reason,
      code: "stripe_blocks",
    });
  });

  it("a write with a malformed body is 422 and still logged with code invalid_body and no reason", async () => {
    const lot = await pendingLot();
    const key = freshKey("reject");

    const res = await call(running.baseUrl, paths.reject(lot.lotId), { body: { reason: "" }, idempotencyKey: key });

    expect(res.status).toBe(422);
    const line = await theOneLine();
    expect(line).toMatchObject({
      adminId: ADMIN,
      method: "POST",
      path: paths.reject(lot.lotId),
      idempotencyKey: key,
      status: 422,
      code: "invalid_body",
    });
    expect(line["reason"]).toBeUndefined();
  });

  it("a rate-limited request is 429 and its line names no admin and carries code rate_limited", async () => {
    const { max } = getRateLimit("internal-api");
    const probe = paths.preview("00000000-0000-4000-8000-000000000000");
    for (let i = 0; i < max; i += 1) {
      expect((await call(running.baseUrl, probe, { unsigned: true })).status).toBe(401);
    }
    await vi.waitFor(() => expect(requestLines()).toHaveLength(max), { timeout: 2_000, interval: 10 });
    logged.info.mockClear();

    const limited = await call(running.baseUrl, probe);

    expect(limited.status).toBe(429);
    const line = await theOneLine();
    expect(line).toMatchObject({ method: "GET", path: probe, status: 429, code: "rate_limited" });
    expect(line["adminId"]).toBeUndefined();
  });
});
