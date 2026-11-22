// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A charge request settles once, in one commit (inner#1611, inner#1617). The
 * Studio's members learn of it from the trigger on the credit tables (#1580),
 * so settling sends nothing itself.
 *
 * The charge-request repository is a stand-in here (`creditCharge.repo.ts`,
 * design §3.1). The names below are the interface this suite assumes; what it
 * asserts is the order of lock, charge, mark-settled and commit.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as CoreModule from "@breatic/core";

/** A charge request row as the repository returns it. */
interface RequestRow {
  id: string;
  kind: "task" | "timeline_execution" | "operation";
  actorUserId: string;
  referenceId: string;
  projectId: string | null;
  amount: string;
  description: string | null;
  model: string | null;
  provider: string | null;
  tokensUsed: number | null;
  releaseHold: string | null;
  status: "pending" | "settled";
}

const h = vi.hoisted(() => ({
  order: [] as string[],
  rows: new Map<string, RequestRow>(),
  keys: new Map<string, string>(),
  recordFailure: vi.fn(async (..._args: unknown[]): Promise<void> => undefined),
  appendLedgerEntry: vi.fn(async (..._args: unknown[]): Promise<void> => undefined),
}));

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof CoreModule>()),
  env: { PAYMENT_ENABLED: true, ENV: "test" },
  db: {
    transaction: async (run: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      const result = await run({});
      h.order.push("commit");
      return result;
    },
  },
}));

vi.mock("@domain/asset/asset.service.js", () => ({
  resolveOwnerStudioId: async () => "studio-1",
}));

vi.mock("@domain/credit/creditHold.repo.js", () => ({
  releaseHold: async () => undefined,
}));

vi.mock("@domain/credit/creditLot.repo.js", () => ({
  lockDebt: async () => {
    h.order.push("lock-debt");
    return "0";
  },
  listSpendableLots: async () => [{ id: "lot-1", userId: "buyer-1" }],
  lockLot: async () => ({ id: "lot-1", lifecycle: "active", designatedStudioId: "studio-1", remainingCredits: "100" }),
  applyCharge: async () => undefined,
  appendLedgerEntry: (...args: unknown[]) => h.appendLedgerEntry(...args),
  adjustDebt: async () => undefined,
  recordStandaloneUsage: async () => undefined,
}));

vi.mock("@domain/credit/creditCharge.repo.js", () => ({
  insertPending: async (input: Omit<RequestRow, "id" | "status" | "amount"> & { amount: number | string }): Promise<string | null> => {
    const key = `${input.kind}:${input.actorUserId}:${input.referenceId}`;
    if (h.keys.has(key)) return null;
    const id = `req-${h.keys.size + 1}`;
    h.keys.set(key, id);
    h.rows.set(id, {
      id,
      kind: input.kind,
      actorUserId: input.actorUserId,
      referenceId: input.referenceId,
      projectId: input.projectId,
      amount: Number(input.amount).toFixed(6),
      description: input.description ?? null,
      model: input.model ?? null,
      provider: input.provider ?? null,
      tokensUsed: input.tokensUsed ?? null,
      releaseHold: input.releaseHold ?? null,
      status: "pending",
    });
    return id;
  },
  lockById: async (id: string): Promise<RequestRow | null> => {
    h.order.push("lock-request");
    const row = h.rows.get(id);
    return row ? { ...row } : null;
  },
  markSettled: async (id: string): Promise<void> => {
    h.order.push("mark-settled");
    const row = h.rows.get(id);
    if (row) row.status = "settled";
  },
  recordFailure: (...args: unknown[]) => h.recordFailure(...args),
}));

const { settleCharge, chargeOnce } = await import("@domain/credit/creditLot.service.js");

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const INPUT = { projectId: PROJECT, actorUserId: ACTOR, amount: 10 };

/**
 * Put a pending request in the stand-in table.
 * @param id - Its id.
 * @param status - Where it stands.
 */
function seedRequest(id: string, status: RequestRow["status"] = "pending"): void {
  h.rows.set(id, {
    id,
    kind: "task",
    actorUserId: ACTOR,
    referenceId: `ref-${id}`,
    projectId: PROJECT,
    amount: "10.000000",
    description: null,
    model: null,
    provider: null,
    tokensUsed: null,
    releaseHold: null,
    status,
  });
}

beforeEach(() => {
  h.order.length = 0;
  h.rows.clear();
  h.keys.clear();
  h.recordFailure.mockClear();
  h.appendLedgerEntry.mockClear();
});

describe("settleCharge", () => {
  it("locks the request before the debt and marks it settled in the charge's commit", async () => {
    seedRequest("req-a");

    const outcome = await settleCharge("req-a");

    // The request row is the first lock; marking it settled is part of the
    // charge's own commit.
    expect(h.order[0]).toBe("lock-request");
    expect(h.order.indexOf("lock-debt")).toBeGreaterThan(0);
    expect(h.order.indexOf("mark-settled")).toBeGreaterThan(0);
    expect(h.order.indexOf("commit")).toBeGreaterThan(h.order.indexOf("lock-debt"));
    expect(h.order.indexOf("commit")).toBeGreaterThan(h.order.indexOf("mark-settled"));
    expect(h.order.at(-1)).toBe("commit");
    expect(outcome).toMatchObject({ billed: true, charged: "10.000000", shortfall: "0.000000" });
    expect(h.rows.get("req-a")?.status).toBe("settled");
  });

  it("returns null for a request already settled, charging nothing", async () => {
    seedRequest("req-c", "settled");

    await expect(settleCharge("req-c")).resolves.toBeNull();

    expect(h.appendLedgerEntry).not.toHaveBeenCalled();
    expect(h.order).not.toContain("lock-debt");
    expect(h.order).not.toContain("mark-settled");
  });
});

describe("chargeOnce", () => {
  it("charges once under a key, and a second call under it charges nothing", async () => {
    await expect(chargeOnce("operation", "turn:c1:1", INPUT)).resolves.toMatchObject({ charged: "10.000000" });
    expect(h.recordFailure).not.toHaveBeenCalled();

    h.appendLedgerEntry.mockClear();
    await expect(chargeOnce("operation", "turn:c1:1", INPUT)).resolves.toBeNull();
    expect(h.appendLedgerEntry).not.toHaveBeenCalled();
  });

  it("refuses a key outside the pattern before writing anything", async () => {
    await expect(chargeOnce("operation", "turn c1 1", INPUT)).rejects.toThrow();
    expect(h.rows.size).toBe(0);
  });
});
