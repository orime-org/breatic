// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The one place the worker settles a charge request and logs it (inner#1617).
 *
 * A completed task, a Timeline execution and the sweep all go through
 * `settleChargeLogged`, so what on-call reads for a stuck or short charge is
 * decided here: every line carries the caller's context and the request id,
 * and nothing it does throws, because the result is already delivered.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as CoreModule from "@breatic/core";
import type * as DomainModule from "@breatic/domain";

const h = vi.hoisted(() => ({
  settleCharge: vi.fn<(requestId: string) => Promise<unknown>>(),
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return { ...actual, logger: { info: vi.fn(), warn: h.warn, error: h.error, debug: vi.fn() } };
});

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  return { ...actual, creditLotService: { ...actual.creditLotService, settleCharge: h.settleCharge } };
});

import { settleChargeLogged } from "@worker/handlers/settle-charge.js";

const CONTEXT = { executionId: "exec-1", userId: "user-1", amount: 3 };
const OUTCOME = { billed: true, charged: "3.000000", shortfall: "0.000000", studioId: "studio-1", lotIds: ["lot-1"] };

beforeEach(() => {
  vi.clearAllMocks();
  h.settleCharge.mockResolvedValue(OUTCOME);
});

describe("settleChargeLogged", () => {
  it("settles the request and logs nothing when it was charged in full", async () => {
    await expect(settleChargeLogged("req-1", CONTEXT)).resolves.toBeUndefined();
    expect(h.settleCharge).toHaveBeenCalledExactlyOnceWith("req-1");
    expect(h.error).not.toHaveBeenCalled();
    expect(h.warn).not.toHaveBeenCalled();
  });

  it("logs nothing when the request was already settled", async () => {
    h.settleCharge.mockResolvedValue(null);
    await settleChargeLogged("req-1", CONTEXT);
    expect(h.error).not.toHaveBeenCalled();
  });

  it("logs a shortfall for reconciliation with the context, the request and what was and was not charged", async () => {
    h.settleCharge.mockResolvedValue({ ...OUTCOME, charged: "1.000000", shortfall: "2.000000" });
    await settleChargeLogged("req-1", CONTEXT);
    expect(h.error).toHaveBeenCalledExactlyOnceWith(
      { executionId: "exec-1", userId: "user-1", amount: 3, requestId: "req-1", studioId: "studio-1", charged: "1.000000", shortfall: "2.000000" },
      "CREDIT_SHORTFALL_AFTER_COMPLETION — manual reconciliation required",
    );
  });

  it("logs a one-micro-credit shortfall and keeps a zero one silent", async () => {
    h.settleCharge.mockResolvedValueOnce({ ...OUTCOME, shortfall: "0.000000" });
    await settleChargeLogged("req-1", CONTEXT);
    expect(h.error).not.toHaveBeenCalled();

    h.settleCharge.mockResolvedValueOnce({ ...OUTCOME, charged: "2.999999", shortfall: "0.000001" });
    await settleChargeLogged("req-1", CONTEXT);
    expect(h.error).toHaveBeenCalledTimes(1);
  });

  it("logs a credits signal that failed with the context and the request", async () => {
    const redis = new Error("redis down");
    h.settleCharge.mockResolvedValue({ ...OUTCOME, signalFailure: redis });
    await settleChargeLogged("req-1", CONTEXT);
    expect(h.error).toHaveBeenCalledExactlyOnceWith({ executionId: "exec-1", userId: "user-1", amount: 3, err: redis, requestId: "req-1" }, "credits_signal_failed");
  });

  it("logs both a shortfall and a failed signal from one settlement", async () => {
    const redis = new Error("redis down");
    h.settleCharge.mockResolvedValue({ ...OUTCOME, charged: "1.000000", shortfall: "2.000000", signalFailure: redis });
    await settleChargeLogged("req-1", CONTEXT);
    expect(h.error.mock.calls.map(([, message]) => message)).toEqual([
      "CREDIT_SHORTFALL_AFTER_COMPLETION — manual reconciliation required",
      "credits_signal_failed",
    ]);
  });

  it("logs a settlement that threw and does not throw", async () => {
    const down = new Error("deadlock detected");
    h.settleCharge.mockRejectedValue(down);
    await expect(settleChargeLogged("req-1", CONTEXT)).resolves.toBeUndefined();
    expect(h.error).toHaveBeenCalledExactlyOnceWith({ executionId: "exec-1", userId: "user-1", amount: 3, err: down, requestId: "req-1" }, "credit_charge_settle_failed");
  });

  it("does not let the context overwrite the request id or the error", async () => {
    const down = new Error("deadlock detected");
    h.settleCharge.mockRejectedValue(down);
    await settleChargeLogged("req-1", { requestId: "stale", err: "stale", taskId: "task-1", userId: "user-1", amount: "3.000000" });
    expect(h.error).toHaveBeenCalledExactlyOnceWith(
      { taskId: "task-1", userId: "user-1", amount: "3.000000", err: down, requestId: "req-1" },
      "credit_charge_settle_failed",
    );
  });
});
