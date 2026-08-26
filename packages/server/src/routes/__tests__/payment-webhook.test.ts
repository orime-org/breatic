// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * webhook 路由本身（#106 §8）—— 它把一个事件分给哪条腿、答什么状态码。
 *
 * 这条路由此前一个测试都没有，而它已经错过两次，两次都是分流写错、两次都
 * 是真付款之后才被发现：先是订阅结账被送进积分那条腿，查不到 payments 行，
 * 404 回给一次成功的付款；再是订阅事件在写完库之后抛 TypeError，500。两次
 * 服务层的测试都全绿——因为它们根本不经过这个文件。
 *
 * **这个文件里的 logger 是裸的 pino，跟线上一样**。默认导出的那个 logger 是
 * 一层会自动 bind 的 Proxy，而 `initLogger` 一跑就把它换成裸实例；服务真正
 * 用的是后者。测试若停在 Proxy 上，`const log = logger.warn` 这种写法在测试
 * 里永远不会抛，而在线上每次都抛——上面那个 500 正是这么漏过去的。
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const { verifyWebhookSignature, handleSubscriptionEvent, paymentService } =
  vi.hoisted(() => ({
    verifyWebhookSignature: vi.fn(),
    handleSubscriptionEvent: vi.fn(),
    paymentService: { fulfillPayment: vi.fn() },
  }));

vi.mock("@server/infra/stripe.js", () => ({ verifyWebhookSignature }));

vi.mock("@server/modules/subscription/subscription-events.js", () => ({
  handleSubscriptionEvent,
}));

// Only the two the route reaches. `authService` comes along because the auth
// middleware imports the same barrel, and the routes beside the webhook are
// wired to it.
vi.mock("@server/modules", () => ({
  paymentService,
  authService: { verifySession: vi.fn() },
}));

import { initLogger } from "@breatic/core";
import { paymentRoute as payment } from "@server/routes/payment.js";

/**
 * Sends one signed event at the route.
 * @param event - What signature verification will hand back.
 * @returns The route's response.
 */
async function post(event: unknown): Promise<Response> {
  verifyWebhookSignature.mockReturnValue(event);
  return payment.request("/webhook", {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=whatever" },
    body: "{}",
  });
}

beforeAll(() => {
  // Production shape: a real pino instance, not the binding Proxy. Sinks are
  // pointed at a scratch directory and the console is silenced so the suite
  // stays quiet; what matters is the object, not where it writes.
  initLogger("payment-webhook-test", {
    logsRoot: resolve(tmpdir(), "breatic-test-logs"),
    debug: false,
    console: "none",
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /payment/webhook — 分流与状态码", () => {
  it("订阅结账完成答 200，不落到积分那条腿上", async () => {
    // 会员结账成功后 Stripe 送的就是这一个，而它跟积分包结账是同一个事件
    // 类型。曾经这里返 404：积分那条腿去找一行订阅结账从不写的 payments。
    handleSubscriptionEvent.mockResolvedValue({
      status: "acknowledged",
      reason: "a subscription checkout finished; its state arrives separately",
    });

    const res = await post({
      id: "evt_1",
      type: "checkout.session.completed",
      data: { object: { id: "cs_1", mode: "subscription" } },
    });

    expect(res.status).toBe(200);
    expect(paymentService.fulfillPayment).not.toHaveBeenCalled();
  });

  it("档位真被改动的事件答 200", async () => {
    handleSubscriptionEvent.mockResolvedValue({
      status: "applied",
      userId: "u-1",
      tier: "pro",
    });

    const res = await post({
      id: "evt_2",
      type: "customer.subscription.created",
      data: { object: { id: "sub_1" } },
    });

    expect(res.status).toBe(200);
  });

  it("认不出账号也答 200，不是 500", async () => {
    // 这一支要记 warn。记日志那一步本身出错的话，状态码就会变成 500——付了
    // 钱的人拿到 500，而 Stripe 会一直重投同一个必然失败的事件。
    handleSubscriptionEvent.mockResolvedValue({
      status: "noop",
      reason: "no account claims Stripe customer cus_x",
    });

    const res = await post({
      id: "evt_3",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_2" } },
    });

    expect(res.status).toBe(200);
  });

  it("不是订阅腿的事件才交给积分那条腿", async () => {
    handleSubscriptionEvent.mockResolvedValue({ status: "notMine" });
    paymentService.fulfillPayment.mockResolvedValue({
      status: "granted",
      credits: 500,
      userId: "u-1",
    });

    const res = await post({
      id: "evt_4",
      type: "checkout.session.completed",
      data: { object: { id: "cs_2", mode: "payment" } },
    });

    expect(res.status).toBe(200);
    // 事件 id 一路传进去：认领就是靠它挡住 Stripe 的重投。
    expect(paymentService.fulfillPayment).toHaveBeenCalledWith("cs_2", "evt_4");
  });

  it("签名不对答 400，且不碰任何一条腿", async () => {
    verifyWebhookSignature.mockImplementation(() => {
      throw new Error("bad signature");
    });

    const res = await payment.request("/webhook", {
      method: "POST",
      headers: { "stripe-signature": "nope" },
      body: "{}",
    });

    expect(res.status).toBe(400);
    expect(handleSubscriptionEvent).not.toHaveBeenCalled();
    expect(paymentService.fulfillPayment).not.toHaveBeenCalled();
  });
});
