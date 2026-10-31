// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Hono } from "hono";
import type * as BreaticCore from "@breatic/core";
import { logger } from "@breatic/core";
import { HTTPException } from "hono/http-exception";
import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  verify: vi.fn(),
  start: vi.fn(),
  finish: vi.fn(),
  parseIdentity: vi.fn(),
  dispatch: vi.fn(),
  legacySubscription: vi.fn(),
  legacyFulfill: vi.fn(),
}));
vi.mock("@server/infra/stripe.js", () => ({ verifyWebhookSignature: mocked.verify }));
vi.mock("@breatic/core", async importOriginal => ({
  ...await importOriginal<typeof BreaticCore>(),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("@server/modules/subscription/subscription-events.js", () => ({ handleSubscriptionEvent: mocked.legacySubscription }));
vi.mock("@server/modules", () => ({
  authService: { verifySession: vi.fn() },
  paymentService: { fulfillPayment: mocked.legacyFulfill },
  stripeWebhookRecordingService: {
    parseWebhookIdentity: mocked.parseIdentity,
    startWebhookAttempt: mocked.start,
    finishWebhookAttempt: mocked.finish,
  },
  stripeWebhookDispatchService: { dispatchStripeWebhook: mocked.dispatch },
}));

import { paymentRoute } from "@server/routes/payment.js";
import { errorHandler } from "@server/middleware/error-handler.js";

const event = { id: "evt_attempt", type: "charge.updated", livemode: false, data: { object: { id: "ch_demo" } } };

/** Creates an app with the production error boundary. */
function app(): Hono {
  const value = new Hono();
  value.onError(errorHandler);
  value.route("/payment", paymentRoute);
  return value;
}

/** Delivers bytes through the actual payment route. */
async function post(): Promise<Response> {
  return app().request("/payment/webhook", { method: "POST", headers: { "stripe-signature": "fixture-signature" }, body: "{}" });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.verify.mockReturnValue(event);
  mocked.parseIdentity.mockReturnValue({ eventId: event.id, eventType: event.type, livemode: false, connectedAccountId: null });
  mocked.start.mockResolvedValue(undefined);
  mocked.finish.mockResolvedValue("recorded");
  mocked.dispatch.mockResolvedValue({ result: "ignored", responseStatus: 200, received: true });
  mocked.legacySubscription.mockResolvedValue({ status: "notMine" });
  mocked.legacyFulfill.mockResolvedValue({ status: "noop" });
});

describe("persisted Stripe attempt HTTP boundary", () => {
  it("commits the start before dispatch and completes after the response is formed", async () => {
    const trace: string[] = [];
    let release: (() => void) | undefined;
    mocked.start.mockImplementation(async () => {
      trace.push("begin");
      await new Promise<void>(resolve => { release = resolve; });
      trace.push("committed");
    });
    mocked.dispatch.mockImplementation(async () => { trace.push("business"); return { result: "ignored", responseStatus: 200, received: true }; });
    mocked.finish.mockImplementation(async () => { trace.push("finish"); return "recorded"; });
    const response = post();
    await vi.waitFor(() => expect(mocked.start).toHaveBeenCalledTimes(1));
    expect(mocked.dispatch).toHaveBeenCalledTimes(0);
    release!();
    expect((await response).status).toBe(200);
    expect(trace).toEqual(["begin", "committed", "business", "finish"]);
    const id = mocked.start.mock.calls[0]![0] as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(mocked.finish).toHaveBeenCalledWith(id, 200, "ignored");
    expect(logger.error).not.toHaveBeenCalledWith(expect.anything(), "stripe_webhook_handler_failed");
  });

  it("rejects a failed or unknown begin acknowledgement before business", async () => {
    mocked.start.mockRejectedValue(new Error("controlled begin acknowledgement loss"));
    const response = await post();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ received: false });
    expect(mocked.dispatch).toHaveBeenCalledTimes(0);
    expect(mocked.finish).toHaveBeenCalledTimes(0);
    expect(logger.error).toHaveBeenCalledWith({
      err: expect.any(Error),
      ctx: { attemptId: mocked.start.mock.calls[0]![0], eventId: event.id, type: event.type, stage: "begin" },
    }, "stripe_webhook_record_failed");
  });

  it.each([200, 500] as const)("preserves the business %s response when completion cannot be acknowledged", async status => {
    mocked.dispatch.mockResolvedValue({ result: status === 200 ? "refund_no_target" : "refund_unreadable", responseStatus: status, received: status === 200 });
    mocked.finish.mockRejectedValue(new Error("controlled finish acknowledgement loss"));
    const response = await post();
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ received: status === 200 });
    expect(mocked.start).toHaveBeenCalledTimes(1);
    expect(mocked.dispatch).toHaveBeenCalledTimes(1);
    expect(mocked.finish).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith({
      err: expect.any(Error),
      ctx: { attemptId: mocked.start.mock.calls[0]![0], eventId: event.id, type: event.type, stage: "finish" },
    }, "stripe_webhook_record_failed");
  });

  it.each([new Error("controlled business failure"), new HTTPException(409)])("records the response formed by the existing error boundary", async error => {
    mocked.dispatch.mockRejectedValue(error);
    const response = await post();
    const expected = error instanceof HTTPException ? 409 : 500;
    expect(response.status).toBe(expected);
    expect(mocked.finish).toHaveBeenCalledWith(expect.any(String), expected, "handler_exception");
  });

  it.each([new Error("controlled business failure"), new HTTPException(409)])("associates a handler exception with its saved attempt and response", async error => {
    mocked.dispatch.mockRejectedValue(error);
    const response = await post();
    const id = mocked.start.mock.calls[0]![0] as string;
    expect(logger.error).toHaveBeenCalledWith({
      err: error,
      ctx: { attemptId: id, eventId: event.id, type: event.type, stage: "handler", responseStatus: response.status },
    }, "stripe_webhook_handler_failed");
    expect(mocked.finish).toHaveBeenCalledWith(id, response.status, "handler_exception");
  });

  it("keeps concurrent exception diagnostics associated with their own attempts", async () => {
    const inputs = ["evt_concurrent_first", "evt_concurrent_second"].map(id => ({ ...event, id, data: { object: { id: "ch_private", payload: "controlled-payload-secret" } } }));
    for (const input of inputs) mocked.verify.mockReturnValueOnce(input);
    mocked.parseIdentity.mockImplementation((input: typeof event) => ({ eventId: input.id, eventType: input.type, livemode: false, connectedAccountId: null }));
    const error = new Error("controlled shared exception");
    mocked.dispatch.mockRejectedValue(error);
    const responses = await Promise.all(inputs.map(() => post()));
    expect(responses.map(response => response.status)).toEqual([500, 500]);
    const diagnostics = vi.mocked(logger.error).mock.calls.filter(call => call[1] === "stripe_webhook_handler_failed");
    expect(diagnostics).toHaveLength(2);
    for (const [id, identity] of mocked.start.mock.calls as [string, { eventId: string; eventType: string }][]) {
      expect(diagnostics).toContainEqual([{
        err: error,
        ctx: { attemptId: id, eventId: identity.eventId, type: identity.eventType, stage: "handler", responseStatus: 500 },
      }, "stripe_webhook_handler_failed"]);
      expect(mocked.finish).toHaveBeenCalledWith(id, 500, "handler_exception");
    }
    expect(new Set(mocked.start.mock.calls.map(call => call[0])).size).toBe(2);
    expect(JSON.stringify(diagnostics)).not.toContain("controlled-payload-secret");
    expect(JSON.stringify(diagnostics)).not.toContain("fixture-signature");
  });

  it("leaves recording unstarted for a rejected signature", async () => {
    mocked.verify.mockImplementation(() => { throw new Error("controlled invalid signature"); });
    const response = await post();
    expect(response.status).toBe(400);
    expect(mocked.start).toHaveBeenCalledTimes(0);
    expect(mocked.dispatch).toHaveBeenCalledTimes(0);
  });

  it("passes an absent signature as empty text to the existing verifier", async () => {
    mocked.verify.mockImplementation(() => { throw new Error("controlled missing signature"); });
    const response = await app().request("/payment/webhook", { method: "POST", body: "{}" });
    expect(response.status).toBe(400);
    expect(mocked.verify).toHaveBeenCalledWith("{}", "");
    expect(mocked.start).toHaveBeenCalledTimes(0);
    expect(mocked.dispatch).toHaveBeenCalledTimes(0);
  });

  it("rejects an unrecordable verified event before recording or business", async () => {
    mocked.parseIdentity.mockReturnValue(null);
    const response = await post();
    expect(response.status).toBe(400);
    expect(mocked.start).toHaveBeenCalledTimes(0);
    expect(mocked.dispatch).toHaveBeenCalledTimes(0);
  });

  it("assigns independent attempt identities to every redelivery", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 12 }), async count => {
      mocked.start.mockClear();
      mocked.finish.mockClear();
      const responses = await Promise.all(Array.from({ length: count }, () => post()));
      expect(responses.map(response => response.status)).toEqual(Array.from({ length: count }, () => 200));
      const ids = mocked.start.mock.calls.map(call => call[0] as string);
      expect(new Set(ids).size).toBe(count);
      expect(mocked.finish).toHaveBeenCalledTimes(count);
    }), { numRuns: 8 });
  });
});
