// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 订阅路由本身（#106 §7）—— 它拦什么、放什么。
 *
 * 这个文件此前一个测试都没有，而它自己的文件头写着两条承诺：关掉支付时四个
 * 端点一律 404（自部署没有订阅这回事，不该出现一个走到一半才失败的入口），
 * 以及每个端点都要过限流（每一次调用都往 Stripe 打真实请求，而 Stripe 的
 * 限额是我们整个账号共用的）。两条都没有任何东西钉着。
 *
 * 服务层整个被替身顶掉：这里断言的是路由这一层的决定，不是业务。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const { service, membership, rateLimitFor, envRef, adsAllowedFor, conversionOf } = vi.hoisted(() => ({
  adsAllowedFor: vi.fn(async () => true),
  conversionOf: vi.fn(),
  service: {
    startCheckout: vi.fn(),
    changePlan: vi.fn(),
    cancel: vi.fn(),
    resume: vi.fn(),
    confirmCheckout: vi.fn(),
  },
  membership: { readAccountMembership: vi.fn() },
  rateLimitFor: vi.fn(),
  envRef: { PAYMENT_ENABLED: true },
}));

vi.mock("@server/modules/subscription/subscription.service.js", () => service);
vi.mock("@server/modules/account/membership.service.js", () => membership);
// Plan prices come from the deployment's config, which these tests do not load.
vi.mock("@server/modules/subscription/subscription-analytics.js", () => ({ subscriptionConversion: conversionOf }));

vi.mock("@server/middleware/rate-limit.js", () => ({
  rateLimitFor: (...args: unknown[]) => {
    rateLimitFor(...args);
    return async (_c: unknown, next: () => Promise<void>) => next();
  },
}));

// What a repeated press gets back is runOnce's own suite; this one is the
// route's translation into a service call.
vi.mock("@server/middleware/run-once.js", () => ({
  runOnce: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock("@server/middleware/auth.js", () => ({
  requireAuth: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("user", { id: "u-1" });
    return next();
  },
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // `logger` too: it is a lazy singleton that reads env on first use, and the
  // handlers log on the way out.
  return {
    ...actual,
    env: envRef,
    adsAllowedFor,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

import { Hono } from "hono";
import { AppError, initCore, loadLocales } from "@breatic/core";
import { errorHandler } from "@server/middleware/error-handler.js";
import { subscriptionRoute } from "@server/routes/subscription.js";

try {
  initCore(process.env);
} catch {
  // Already initialised by a sibling suite in this worker.
}
loadLocales();

// The route is mounted the way `app.ts` mounts it, error handler included:
// what a refusal ANSWERS is the thing under test, and that answer is decided
// by the pair rather than by the route alone.
const app = new Hono();
app.route("/", subscriptionRoute);
app.onError(errorHandler);

/**
 * Sends one request at the route.
 * @param path - The endpoint under `/`.
 * @param body - The JSON body.
 * @returns The response.
 */
async function post(path: string, body: unknown = {}): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// The rate limit is applied when the module loads, so its record is taken
// before any per-test clearing can wipe it.
const rateLimitCalls = [...rateLimitFor.mock.calls];

beforeEach(() => {
  service.startCheckout.mockClear();
  service.changePlan.mockClear();
  service.cancel.mockClear();
  service.resume.mockClear();
  service.confirmCheckout.mockReset();
  membership.readAccountMembership.mockReset();
  envRef.PAYMENT_ENABLED = true;
  service.startCheckout.mockResolvedValue({ url: "https://checkout.example/s" });
  service.changePlan.mockResolvedValue({ status: "applied", payableInvoiceUrl: null });
  service.cancel.mockResolvedValue({});
  service.resume.mockResolvedValue({});
});

describe("订阅路由 — 关掉支付时的四个闸门", () => {
  it.each([
    ["/checkout", { tier: "pro", period: "month", return_url: "https://app.example/me" }],
    ["/change", { tier: "team", period: "year" }],
    ["/cancel", {}],
    ["/resume", {}],
    ["/confirm", { session_id: "cs_1" }],
  ])("%s 在不卖东西的部署上答 404", async (path, body) => {
    // 404 而不是 403：自部署上这些端点不是「你没权限」，是根本不存在这个功能。
    envRef.PAYMENT_ENABLED = false;

    const res = await post(path, body);

    expect(res.status).toBe(404);
    expect(service.startCheckout).not.toHaveBeenCalled();
    expect(service.changePlan).not.toHaveBeenCalled();
    expect(service.cancel).not.toHaveBeenCalled();
    expect(service.resume).not.toHaveBeenCalled();
    expect(service.confirmCheckout).not.toHaveBeenCalled();
  });
});

describe("订阅路由 — 限流", () => {
  it("四个端点共用一道限流，按账号计", async () => {
    // 挂在路由器上而不是逐个端点挂：四个是同一类动作，逐个挂的清单就是第五个
    // 端点被漏掉的地方。
    expect(rateLimitCalls).toContainEqual(["subscription-write", "user"]);
  });
});

describe("订阅路由 — 把请求翻译成业务调用", () => {
  it("hands the tier, the period and the return address to the service as they came", async () => {
    const res = await post("/checkout", {
      tier: "pro",
      period: "year",
      return_url: "https://app.example/me",
    });

    expect(res.status).toBe(200);
    expect(service.startCheckout).toHaveBeenCalledWith({
      userId: "u-1",
      tier: "pro",
      period: "year",
      returnUrl: "https://app.example/me",
    });
  });

  it("refuses a request that names no period before the service sees it", async () => {
    // A tier has two prices. Without this half the service would have to
    // pick one, and neither of them is the one the reader pressed. Stopping
    // it here is what keeps a default period from existing at all.
    const res = await post("/checkout", {
      tier: "pro",
      return_url: "https://app.example/me",
    });

    expect(res.status).toBe(422);
    expect(service.startCheckout).not.toHaveBeenCalled();
  });

  it("refuses a period that is neither of the two words", async () => {
    const res = await post("/change", { tier: "team", period: "weekly" });

    expect(res.status).toBe(422);
    expect(service.changePlan).not.toHaveBeenCalled();
  });

  it("档位不在价目表上时不进业务层", async () => {
    const res = await post("/checkout", {
      tier: "enterprise",
      return_url: "https://app.example/me",
    });

    // 422：请求体形状对但值不合法，是 `validate` 中间件的答复，业务层没被碰。
    expect(res.status).toBe(422);
    expect(service.startCheckout).not.toHaveBeenCalled();
  });

  it("取消和恢复不需要请求体", async () => {
    expect((await post("/cancel")).status).toBe(200);
    expect(service.cancel).toHaveBeenCalledWith("u-1");

    expect((await post("/resume")).status).toBe(200);
    expect(service.resume).toHaveBeenCalledWith("u-1");
  });
});

describe("POST /confirm — the return from a membership checkout (#307 A5–A7)", () => {
  it("refuses a body that names no session before the service sees it", async () => {
    const res = await post("/confirm", {});

    expect(res.status).toBe(422);
    expect(service.confirmCheckout).not.toHaveBeenCalled();
  });

  it("confirms the named session for the signed-in account and answers with the panel", async () => {
    // Not active yet, so no ad conversion rides along (inner#1442 §4.9).
    service.confirmCheckout.mockResolvedValue({ stripeSubscriptionId: "sub_1", status: "incomplete", tier: "pro", period: "month" });
    conversionOf.mockReturnValue(null);
    membership.readAccountMembership.mockResolvedValue({ tier: "pro" });

    const res = await post("/confirm", { session_id: "cs_1" });

    expect(res.status).toBe(200);
    expect(service.confirmCheckout).toHaveBeenCalledWith("u-1", "cs_1");
    expect(await res.json()).toEqual({ data: { tier: "pro", conversion: null } });
  });

  it("hands back the ad conversion of an active subscription only while ads are allowed", async () => {
    service.confirmCheckout.mockResolvedValue({ stripeSubscriptionId: "sub_1", status: "active", tier: "pro", period: "month" });
    membership.readAccountMembership.mockResolvedValue({ tier: "pro" });
    conversionOf.mockReturnValue({ transactionId: "sub:sub_1", amountCents: 1700, currency: "usd" });

    adsAllowedFor.mockResolvedValueOnce(true);
    const allowed = (await (await post("/confirm", { session_id: "cs_1" })).json()) as { data: { conversion: unknown } };
    expect(allowed.data.conversion).toMatchObject({ transactionId: "sub:sub_1" });
    expect(adsAllowedFor).toHaveBeenCalledWith("u-1", { consent: false });

    adsAllowedFor.mockResolvedValueOnce(false);
    const refused = (await (await post("/confirm", { session_id: "cs_1" })).json()) as { data: { conversion: unknown } };
    expect(refused.data.conversion).toBeNull();
  });

  it("still confirms a paid subscription when the ads consent lookup fails, with no conversion", async () => {
    service.confirmCheckout.mockResolvedValue({ stripeSubscriptionId: "sub_1", status: "active", tier: "pro", period: "month" });
    membership.readAccountMembership.mockResolvedValue({ tier: "pro" });
    conversionOf.mockReturnValue({ transactionId: "sub:sub_1", amountCents: 1700, currency: "usd" });
    adsAllowedFor.mockRejectedValueOnce(new Error("database down"));

    const res = await post("/confirm", { session_id: "cs_1" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { tier: "pro", conversion: null } });
  });

  it("passes a refusal from the service through as it was", async () => {
    const { NotFoundError } = await import("@breatic/core");
    service.confirmCheckout.mockRejectedValue(new NotFoundError("not yours"));

    const res = await post("/confirm", { session_id: "cs_1" });

    expect(res.status).toBe(404);
  });

  it("passes the service's 503 through when Stripe could not be asked", async () => {
    service.confirmCheckout.mockRejectedValue(new AppError(503, "not confirmed"));

    const res = await post("/confirm", { session_id: "cs_1" });

    expect(res.status).toBe(503);
    expect(membership.readAccountMembership).not.toHaveBeenCalled();
  });

  it("answers a failure of our own as 500, not as Stripe being down", async () => {
    service.confirmCheckout.mockRejectedValue(new Error("database is gone"));

    const res = await post("/confirm", { session_id: "cs_1" });

    expect(res.status).toBe(500);
    expect(membership.readAccountMembership).not.toHaveBeenCalled();
  });
});
