// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The credit charge sweep (inner#1617 design §3.4): every pending request
 * older than the configured age is settled, one at a time. A request whose
 * settle fails is counted on the row by the credit engine and logged here
 * with what on-call needs to find it (kind, reference, actor, amount,
 * attempts), and the sweep goes on to the next one; nothing a single request
 * does stops the round or throws out of it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as CoreModule from "@breatic/core";
import type * as DomainModule from "@breatic/domain";

const h = vi.hoisted(() => ({
  getWorkerConfig: vi.fn(),
  listSweepableChargeRequests: vi.fn<(minAgeMs: number, limit: number) => Promise<SweepRow[]>>(),
  settleCharge: vi.fn<(requestId: string) => Promise<unknown>>(),
  error: vi.fn(),
}));

/** A pending request as the sweep lists it. */
interface SweepRow {
  id: string;
  kind: "task" | "timeline_execution" | "operation";
  referenceId: string;
  actorUserId: string;
  amount: string;
  attempts: number;
}

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
    },
  };
});

import { sweepCreditCharges } from "@worker/handlers/credit-charge-sweep.js";

const OUTCOME = { billed: true, charged: "1.000000", shortfall: "0.000000", studioId: "s", lotIds: [] };

const ROWS: SweepRow[] = [
  { id: "req-1", kind: "task", referenceId: "task-1", actorUserId: "user-1", amount: "1.000000", attempts: 0 },
  { id: "req-2", kind: "operation", referenceId: "turn:c1:4", actorUserId: "user-2", amount: "2.500000", attempts: 3 },
  { id: "req-3", kind: "timeline_execution", referenceId: "exec-3", actorUserId: "user-3", amount: "0.010000", attempts: 1 },
];

/**
 * What every log line for a row carries.
 * @param row - The listed row.
 * @returns The fields, by name.
 */
function contextOf(row: SweepRow): Record<string, unknown> {
  return { kind: row.kind, referenceId: row.referenceId, userId: row.actorUserId, amount: row.amount, attempts: row.attempts, requestId: row.id };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getWorkerConfig.mockReturnValue({ credit_charge_sweep: { interval_ms: 60_000, min_age_ms: 30_000, batch_size: 100 } });
  h.listSweepableChargeRequests.mockResolvedValue(ROWS);
  h.settleCharge.mockResolvedValue(OUTCOME);
});

describe("sweepCreditCharges", () => {
  it("lists with the configured age and batch, and settles every listed request in order", async () => {
    h.getWorkerConfig.mockReturnValue({ credit_charge_sweep: { interval_ms: 1_000, min_age_ms: 12_345, batch_size: 7 } });

    await sweepCreditCharges();

    expect(h.listSweepableChargeRequests).toHaveBeenCalledExactlyOnceWith(12_345, 7);
    expect(h.settleCharge.mock.calls.map(([id]) => id)).toEqual(["req-1", "req-2", "req-3"]);
    expect(h.error).not.toHaveBeenCalled();
  });

  it("logs a failing request with what finds it, and still settles the ones after it", async () => {
    const down = new Error("deadlock detected");
    h.settleCharge.mockImplementation(async (id) => {
      if (id === "req-2") throw down;
      return OUTCOME;
    });

    await expect(sweepCreditCharges()).resolves.toBeUndefined();

    expect(h.settleCharge.mock.calls.map(([id]) => id)).toEqual(["req-1", "req-2", "req-3"]);
    expect(h.error).toHaveBeenCalledExactlyOnceWith({ ...contextOf(ROWS[1]!), err: down }, "credit_charge_settle_failed");
  });

  it("goes on when the settlement and its failure record both failed", async () => {
    const both = new AggregateError([new Error("db down"), new Error("still down")], "charge settlement and its failure record both failed");
    h.settleCharge.mockRejectedValueOnce(both);

    await expect(sweepCreditCharges()).resolves.toBeUndefined();

    expect(h.settleCharge).toHaveBeenCalledTimes(3);
    expect(h.error).toHaveBeenCalledExactlyOnceWith({ ...contextOf(ROWS[0]!), err: both }, "credit_charge_settle_failed");
  });

  it("treats a request another settle already finished as done, logging nothing", async () => {
    h.settleCharge.mockResolvedValueOnce(null);

    await sweepCreditCharges();

    expect(h.settleCharge).toHaveBeenCalledTimes(3);
    expect(h.error).not.toHaveBeenCalled();
  });

  it("logs a shortfall for reconciliation with the row's fields and what was charged", async () => {
    h.settleCharge.mockResolvedValueOnce({ ...OUTCOME, charged: "0.400000", shortfall: "0.600000", studioId: "studio-9" });

    await sweepCreditCharges();

    expect(h.error).toHaveBeenCalledExactlyOnceWith(
      { ...contextOf(ROWS[0]!), studioId: "studio-9", charged: "0.400000", shortfall: "0.600000" },
      "CREDIT_SHORTFALL_AFTER_COMPLETION — manual reconciliation required",
    );
  });

  it("logs a settled charge whose credits signal failed", async () => {
    const redis = new Error("redis down");
    h.settleCharge.mockResolvedValueOnce({ ...OUTCOME, signalFailure: redis });

    await sweepCreditCharges();

    expect(h.error).toHaveBeenCalledExactlyOnceWith({ ...contextOf(ROWS[0]!), err: redis }, "credits_signal_failed");
  });

  it("settles nothing when nothing is pending", async () => {
    h.listSweepableChargeRequests.mockResolvedValue([]);

    await sweepCreditCharges();

    expect(h.settleCharge).not.toHaveBeenCalled();
  });
});
