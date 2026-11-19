// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The catch-up processes one event the way a webhook delivery is processed
 * (`middleware/stripe-webhook-recording.ts`): the start is recorded first,
 * then the event is dispatched, then the outcome is recorded. A failure to
 * record the outcome is reported and never changes it; a dispatch error is
 * recorded as `handler_exception` and is the error that propagates.
 */

import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  order: [] as string[],
  start: vi.fn(),
  finish: vi.fn(),
  dispatch: vi.fn(),
}));

vi.mock("@server/modules/stripe-webhook/recording.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@server/modules/stripe-webhook/recording.service.js")>()),
  startWebhookAttempt: (...args: unknown[]) => {
    mocked.order.push("start");
    return mocked.start(...args);
  },
  finishWebhookAttempt: (...args: unknown[]) => {
    mocked.order.push(`finish:${String(args[1])}:${String(args[2])}`);
    return mocked.finish(...args);
  },
}));
vi.mock("@server/modules/stripe-webhook/dispatch.service.js", () => ({
  dispatchStripeWebhook: (...args: unknown[]) => {
    mocked.order.push("dispatch");
    return mocked.dispatch(...args);
  },
}));

import { handleLikeWebhook } from "@server/modules/stripe-webhook/catch-up.js";

const EVENT = {
  id: "evt_1",
  type: "refund.updated",
  livemode: false,
  created: 1,
  data: { object: { id: "re_1" } },
} as unknown as Stripe.Event;

beforeEach(() => {
  mocked.order.length = 0;
  mocked.start.mockReset().mockResolvedValue(undefined);
  mocked.finish.mockReset().mockResolvedValue("recorded");
  mocked.dispatch.mockReset().mockResolvedValue({ result: "refund_synced", responseStatus: 200, received: true });
});

describe("handleLikeWebhook", () => {
  it("records the start, dispatches, records the outcome, and answers the dispatch's status", async () => {
    const onRecordFailed = vi.fn();
    await expect(handleLikeWebhook(EVENT, onRecordFailed)).resolves.toEqual({ responseStatus: 200 });
    expect(mocked.order).toEqual(["start", "dispatch", "finish:200:refund_synced"]);
    expect(onRecordFailed).not.toHaveBeenCalled();
  });

  it("keeps the dispatch's status when only recording the outcome fails", async () => {
    const err = new Error("statement timeout");
    mocked.finish.mockRejectedValueOnce(err);
    const onRecordFailed = vi.fn();
    await expect(handleLikeWebhook(EVENT, onRecordFailed)).resolves.toEqual({ responseStatus: 200 });
    expect(mocked.order).toEqual(["start", "dispatch", "finish:200:refund_synced"]);
    expect(onRecordFailed).toHaveBeenCalledWith("finish", err);
  });

  it("records a dispatch error as handler_exception and propagates that error", async () => {
    const err = new Error("handler blew up");
    mocked.dispatch.mockRejectedValueOnce(err);
    await expect(handleLikeWebhook(EVENT, vi.fn())).rejects.toBe(err);
    expect(mocked.order).toEqual(["start", "dispatch", "finish:500:handler_exception"]);
  });

  it("still propagates the dispatch error when recording it fails too", async () => {
    const err = new Error("handler blew up");
    const recordErr = new Error("db down");
    mocked.dispatch.mockRejectedValueOnce(err);
    mocked.finish.mockRejectedValueOnce(recordErr);
    const onRecordFailed = vi.fn();
    await expect(handleLikeWebhook(EVENT, onRecordFailed)).rejects.toBe(err);
    expect(onRecordFailed).toHaveBeenCalledWith("finish", recordErr);
  });

  it("does not dispatch when the start cannot be recorded", async () => {
    const err = new Error("db down");
    mocked.start.mockRejectedValueOnce(err);
    await expect(handleLikeWebhook(EVENT, vi.fn())).rejects.toBe(err);
    expect(mocked.order).toEqual(["start"]);
  });
});
