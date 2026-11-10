// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The credit charge sweep (inner#1617 design §3.4): every pending request
 * older than the configured age is settled, one at a time. A request whose
 * settle fails is recorded and logged with what on-call needs to find it, and
 * the sweep goes on to the next one; nothing a single request does stops the
 * round or throws out of it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as CoreModule from "@breatic/core";
import type * as DomainModule from "@breatic/domain";

const h = vi.hoisted(() => ({
  getWorkerConfig: vi.fn(),
  listSweepableChargeRequests: vi.fn<(minAgeMs: number, limit: number) => Promise<string[]>>(),
  settleCharge: vi.fn<(requestId: string) => Promise<unknown>>(),
  recordSettleFailure: vi.fn<(requestId: string, err: unknown) => Promise<void>>(),
  error: vi.fn(),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    getWorkerConfig: h.getWorkerConfig,
    logger: { info: vi.fn(), warn: vi.fn(), error: h.error, debug: vi.fn() },
  };
});

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  return {
    ...actual,
    creditLotService: {
      ...actual.creditLotService,
      listSweepableChargeRequests: h.listSweepableChargeRequests,
      settleCharge: h.settleCharge,
      recordSettleFailure: h.recordSettleFailure,
    },
  };
});

import { sweepCreditCharges } from "@worker/handlers/credit-charge-sweep.js";

const OUTCOME = { billed: true, charged: "1.000000", shortfall: "0.000000", studioId: "s", lotIds: [] };

beforeEach(() => {
  vi.clearAllMocks();
  h.getWorkerConfig.mockReturnValue({ credit_charge_sweep: { interval_ms: 60_000, min_age_ms: 30_000, batch_size: 100 } });
  h.listSweepableChargeRequests.mockResolvedValue(["req-1", "req-2", "req-3"]);
  h.settleCharge.mockResolvedValue(OUTCOME);
  h.recordSettleFailure.mockResolvedValue(undefined);
});

describe("sweepCreditCharges", () => {
  it("lists with the configured age and batch, and settles every listed request in order", async () => {
    h.getWorkerConfig.mockReturnValue({ credit_charge_sweep: { interval_ms: 1_000, min_age_ms: 12_345, batch_size: 7 } });

    await sweepCreditCharges();

    expect(h.listSweepableChargeRequests).toHaveBeenCalledExactlyOnceWith(12_345, 7);
    expect(h.settleCharge.mock.calls.map(([id]) => id)).toEqual(["req-1", "req-2", "req-3"]);
    expect(h.recordSettleFailure).not.toHaveBeenCalled();
    expect(h.error).not.toHaveBeenCalled();
  });

  it("records and logs a failing request and still settles the ones after it", async () => {
    const down = new Error("deadlock detected");
    h.settleCharge.mockImplementation(async (id) => {
      if (id === "req-2") throw down;
      return OUTCOME;
    });

    await expect(sweepCreditCharges()).resolves.toBeUndefined();

    expect(h.settleCharge.mock.calls.map(([id]) => id)).toEqual(["req-1", "req-2", "req-3"]);
    expect(h.recordSettleFailure).toHaveBeenCalledExactlyOnceWith("req-2", down);
    expect(h.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: down, requestId: "req-2" }),
      "credit_charge_settle_failed",
    );
  });

  it("goes on when recording a failure fails too", async () => {
    h.settleCharge.mockRejectedValueOnce(new Error("db down"));
    h.recordSettleFailure.mockRejectedValueOnce(new Error("still down"));

    await expect(sweepCreditCharges()).resolves.toBeUndefined();

    expect(h.settleCharge).toHaveBeenCalledTimes(3);
    expect(h.error).toHaveBeenCalledWith(expect.objectContaining({ requestId: "req-1" }), "credit_charge_settle_failed");
  });

  it("treats a request another settle already finished as done, logging nothing", async () => {
    h.settleCharge.mockResolvedValueOnce(null);

    await sweepCreditCharges();

    expect(h.settleCharge).toHaveBeenCalledTimes(3);
    expect(h.recordSettleFailure).not.toHaveBeenCalled();
    expect(h.error).not.toHaveBeenCalled();
  });

  it("logs a settled charge whose credits signal failed, without recording a settle failure", async () => {
    h.settleCharge.mockResolvedValueOnce({ ...OUTCOME, signalFailure: new Error("redis down") });

    await sweepCreditCharges();

    expect(h.recordSettleFailure).not.toHaveBeenCalled();
    expect(h.error).toHaveBeenCalledWith(expect.objectContaining({ requestId: "req-1" }), "credits_signal_failed");
  });

  it("settles nothing when nothing is pending", async () => {
    h.listSweepableChargeRequests.mockResolvedValue([]);

    await sweepCreditCharges();

    expect(h.settleCharge).not.toHaveBeenCalled();
  });
});
