// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A committed charge tells the project's readers, and failing to tell them
 * never undoes or repeats the charge (inner#1611).
 *
 * The signal goes out after the transaction commits, so a reader who reads
 * again sees the charge. A publish that fails is handed back on the outcome:
 * thrown instead, `chargeOnceForGeneration` would drop its bill lock and a
 * retry under the same key would charge a second time.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as CoreModule from "@breatic/core";

const h = vi.hoisted(() => ({
  order: [] as string[],
  publish: vi.fn<(projectId: string) => Promise<void>>(),
  del: vi.fn(async () => 1),
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
  getRedis: () => ({ set: async () => "OK", del: h.del }),
  publishCreditsChanged: (projectId: string) => {
    h.order.push("publish");
    return h.publish(projectId);
  },
}));

vi.mock("@domain/asset/asset.service.js", () => ({
  resolveOwnerStudioId: async () => "studio-1",
}));

vi.mock("@domain/credit/creditHold.repo.js", () => ({
  releaseHold: async () => undefined,
}));

vi.mock("@domain/credit/creditLot.repo.js", () => ({
  lockDebt: async () => "0",
  listSpendableLots: async () => [{ id: "lot-1", userId: "buyer-1" }],
  lockLot: async () => ({ id: "lot-1", lifecycle: "active", designatedStudioId: "studio-1", remainingCredits: "100" }),
  applyCharge: async () => undefined,
  appendLedgerEntry: async () => undefined,
  adjustDebt: async () => undefined,
  recordStandaloneUsage: async () => undefined,
}));

const { chargeForGeneration, chargeOnceForGeneration } = await import("@domain/credit/creditLot.service.js");

const PROJECT = "11111111-1111-4111-8111-111111111111";
const INPUT = { projectId: PROJECT, actorUserId: "22222222-2222-4222-8222-222222222222", amount: 10 };

beforeEach(() => {
  h.order.length = 0;
  h.publish.mockReset();
  h.publish.mockResolvedValue(undefined);
  h.del.mockClear();
});

describe("chargeForGeneration and the credits signal", () => {
  it("tells the project's readers after the charge commits", async () => {
    const outcome = await chargeForGeneration(INPUT);

    expect(h.publish).toHaveBeenCalledWith(PROJECT);
    expect(h.order).toEqual(["commit", "publish"]);
    expect(outcome).toMatchObject({ billed: true, charged: 10 });
    expect(outcome.signalFailure).toBeUndefined();
  });

  it("hands a failed publish back on the outcome, with the charge standing", async () => {
    const down = new Error("redis down");
    h.publish.mockRejectedValueOnce(down);

    await expect(chargeForGeneration(INPUT)).resolves.toMatchObject({ billed: true, charged: 10, signalFailure: down });
  });

  it("keeps the bill lock when only the publish failed, so a retry under the key charges nothing", async () => {
    h.publish.mockRejectedValueOnce(new Error("redis down"));

    await expect(chargeOnceForGeneration("turn:c1:1", INPUT)).resolves.toMatchObject({ charged: 10 });
    expect(h.del).not.toHaveBeenCalled();
  });
});
