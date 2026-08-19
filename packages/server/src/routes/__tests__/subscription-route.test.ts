// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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

const { service, rateLimitFor, envRef } = vi.hoisted(() => ({
  service: {
    startCheckout: vi.fn(),
    changePlan: vi.fn(),
    cancel: vi.fn(),
    resume: vi.fn(),
  },
  rateLimitFor: vi.fn(),
  envRef: { PAYMENT_ENABLED: true },
}));

vi.mock("@server/modules/subscription/subscription.service.js", () => service);

vi.mock("@server/middleware/rate-limit.js", () => ({
  rateLimitFor: (...args: unknown[]) => {
    rateLimitFor(...args);
    return async (_c: unknown, next: () => Promise<void>) => next();
  },
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
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

import { Hono } from "hono";
import { initCore, loadLocales } from "@breatic/core";
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
  envRef.PAYMENT_ENABLED = true;
  service.startCheckout.mockResolvedValue({ url: "https://checkout.example/s" });
  service.changePlan.mockResolvedValue({ status: "applied", payableInvoiceUrl: null });
  service.cancel.mockResolvedValue({});
  service.resume.mockResolvedValue({});
});

describe("订阅路由 — 关掉支付时的四个闸门", () => {
  it.each([
    ["/checkout", { tier: "pro", return_url: "https://app.example/me" }],
    ["/change", { tier: "team" }],
    ["/cancel", {}],
    ["/resume", {}],
  ])("%s 在不卖东西的部署上答 404", async (path, body) => {
    // 404 而不是 403：自部署上这些端点不是「你没权限」，是根本不存在这个功能。
    envRef.PAYMENT_ENABLED = false;

    const res = await post(path, body);

    expect(res.status).toBe(404);
    expect(service.startCheckout).not.toHaveBeenCalled();
    expect(service.changePlan).not.toHaveBeenCalled();
    expect(service.cancel).not.toHaveBeenCalled();
    expect(service.resume).not.toHaveBeenCalled();
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
  it("结账把档位和回跳地址原样交给服务层", async () => {
    const res = await post("/checkout", {
      tier: "pro",
      return_url: "https://app.example/me",
    });

    expect(res.status).toBe(200);
    expect(service.startCheckout).toHaveBeenCalledWith({
      userId: "u-1",
      tier: "pro",
      returnUrl: "https://app.example/me",
    });
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
