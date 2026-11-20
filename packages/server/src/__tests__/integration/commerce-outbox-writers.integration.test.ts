// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the product tells the billing service through its outbox (inner#1993
 * §3.4, §5.1): every lifecycle a bought lot takes is appended in the
 * transaction that moves it, and an erased account is appended in the
 * erasure's own transaction. Nothing is appended while the deployment sells
 * nothing, since no relay would ever send it.
 */

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { closeDb, db, eraseAccountAnalytics, initCore } from "@breatic/core";
import { creditLotRepo, creditLotService } from "@breatic/domain";
import { openPaymentSource } from "./payment-source.js";

let sql: ReturnType<typeof postgres>;

/** Core configured to sell through a billing service. */
function sellingCore(): void {
  initCore({
    ...process.env,
    CHARGING_ENABLED: "true",
    INTERNAL_API_ENABLED: "true",
    INTERNAL_API_SECRET: "internal-secret-current-0123456789abcdef",
    COMMERCE_API_URL: "http://127.0.0.1:9",
    COMMERCE_API_SECRET: "commerce-secret-current-0123456789abcdef",
  });
}

beforeAll(() => {
  sellingCore();
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false, connection: { application_name: "commerce-outbox-writers-test" } });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  await closeDb();
  initCore(process.env);
});

/**
 * One account.
 * @returns Its id.
 */
async function account(): Promise<string> {
  const userId = randomUUID();
  await sql`INSERT INTO users(id,email) VALUES (${userId},${`${userId}@example.test`})`;
  return userId;
}

/**
 * The outbox rows for one aggregate, oldest first.
 * @param aggregateKey - The aggregate.
 * @returns Type and payload of each.
 */
async function events(aggregateKey: string): Promise<Array<{ type: string; payload: unknown }>> {
  return sql<{ type: string; payload: unknown }[]>`SELECT type, payload FROM commerce_outbox WHERE aggregate_key = ${aggregateKey} ORDER BY seq`;
}

/**
 * A lot granted from a fresh payment.
 * @returns The lot, its payment and its buyer.
 */
async function grantedLot(): Promise<{ lotId: string; paymentId: string; userId: string }> {
  const userId = await account();
  const paymentId = await openPaymentSource(sql);
  const lot = await creditLotService.grantFromPayment({ paymentId, userId, purchasedCredits: 1000 });
  return { lotId: lot.id, paymentId, userId };
}

describe("lot lifecycle events", () => {
  it("appends every lifecycle a bought lot takes, in order", async () => {
    const { lotId, paymentId, userId } = await grantedLot();

    await creditLotService.requestRefund({ lotId, requestingUserId: userId });
    await db.transaction(async (tx) => {
      await creditLotRepo.lockLot(lotId, tx);
      await creditLotService.markRefunding({ lotId }, tx);
    });
    await db.transaction(async (tx) => {
      await creditLotRepo.lockLot(lotId, tx);
      await creditLotService.settleRefund({ lotId, refundId: "re_1" }, tx);
    });
    await db.transaction(async (tx) => {
      await creditLotRepo.lockLot(lotId, tx);
      await creditLotService.restoreRefundedCredits({ lotId, operationId: randomUUID() }, tx);
    });

    const lifecycle = (l: string): { type: string; payload: unknown } => ({
      type: "lot_refund_lifecycle",
      payload: { lotId, paymentId, userId, lifecycle: l },
    });
    expect(await events(`lot:${lotId}`)).toEqual(["active", "refund_pending", "refunding", "refunded", "active"].map(lifecycle));
  });

  it("appends the rejection and the send-back edges", async () => {
    const { lotId, userId } = await grantedLot();
    await creditLotService.requestRefund({ lotId, requestingUserId: userId });
    await db.transaction(async (tx) => {
      await creditLotRepo.lockLot(lotId, tx);
      await creditLotService.markRefunding({ lotId }, tx);
    });
    await db.transaction(async (tx) => {
      await creditLotRepo.lockLot(lotId, tx);
      await creditLotService.sendBackRefund({ lotId }, tx);
    });
    await db.transaction(async (tx) => {
      await creditLotRepo.lockLot(lotId, tx);
      await creditLotService.rejectRefund({ lotId, operationId: randomUUID() }, tx);
    });

    expect((await events(`lot:${lotId}`)).map((e) => (e.payload as { lifecycle: string }).lifecycle)).toEqual([
      "active",
      "refund_pending",
      "refunding",
      "refund_pending",
      "active",
    ]);
  });

  it("appends nothing for a lot nobody paid for", async () => {
    const userId = await account();
    const [studio] = await sql<{ id: string }[]>`
      INSERT INTO studios (created_by_user_id, slug, type, name) VALUES (${userId}, ${`w-${userId.slice(0, 8)}`}, 'personal', 'Mine') RETURNING id`;
    const lot = await db.transaction((tx) => creditLotService.grantTrialCredits({ userId, studioId: studio!.id, credits: 100 }, tx));

    expect(lot).not.toBeNull();
    expect(await events(`lot:${lot!.id}`)).toEqual([]);
  });

  it("appends nothing while the deployment sells nothing", async () => {
    initCore(process.env);
    try {
      const { lotId } = await grantedLot();
      expect(await events(`lot:${lotId}`)).toEqual([]);
    } finally {
      sellingCore();
    }
  });
});

describe("account erasure events", () => {
  it("appends one erasure per deleted account in the erasure's transaction", async () => {
    const a = await account();
    const b = await account();
    await sql`UPDATE users SET deleted_at = now() WHERE id IN (${a}, ${b})`;

    expect(await eraseAccountAnalytics([a, b])).toEqual({ notDeleted: [] });

    expect(await events(`erasure:${a}`)).toEqual([{ type: "account_erasure", payload: { userId: a } }]);
    expect(await events(`erasure:${b}`)).toEqual([{ type: "account_erasure", payload: { userId: b } }]);
  });

  it("appends nothing when the erasure is refused", async () => {
    const live = await account();

    expect(await eraseAccountAnalytics([live])).toEqual({ notDeleted: [live] });
    expect(await events(`erasure:${live}`)).toEqual([]);
  });
});
