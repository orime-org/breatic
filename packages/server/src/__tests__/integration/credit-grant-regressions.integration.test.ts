// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, initCore } from "@breatic/core";
import { creditLotService } from "@breatic/domain";
import { requestTransfer } from "@server/modules/studio/studioTransfer.service.js";
import { initInternalCore, useInternalApp } from "./internal-api-harness.js";
import { seedDesignatedLot } from "./studio-credit-fixtures.js";
import { applied, grantBody, grantKey, postGrant, seedDebt, seedPersonal } from "./operator-credit-grant-fixtures.js";
import type { PersonalFixture } from "./operator-credit-grant-fixtures.js";

const suite = useInternalApp("credit-grant-regressions");

/** Read one lot and its independent SQL ledger total. */
async function lotState(lotId: string): Promise<{ lifecycle: string; remaining: string; ledger: string }> {
  const [row] = await suite.sql<{ lifecycle: string; remaining: string; ledger: string }[]>`
    select lifecycle,remaining_credits::text as remaining,
      (select coalesce(sum(amount),0)::numeric(20,6)::text from credit_ledger where lot_id=l.id) as ledger
    from credit_lots l where id=${lotId}`;
  return row!;
}

/** Seed an exact paid lot independently of the cost-number quotation boundary. */
async function exactUnassignedPurchase(fx: PersonalFixture, credits: string): Promise<string> {
  const lotId = await seedDesignatedLot(suite.sql, fx, 100);
  await suite.sql`update credit_lots set designated_studio_id=null,purchased_credits=${credits}::numeric,remaining_credits=${credits}::numeric where id=${lotId}`;
  await suite.sql`update payments set credits_granted=${credits}::double precision where id=(select source_id from credit_lots where id=${lotId})`;
  await suite.sql`update credit_ledger set amount=${credits}::numeric where lot_id=${lotId} and entry_type='topup'`;
  return lotId;
}

describe("existing credit behaviours with operator-source support", () => {
  it("P17 retains the disabled registration-grant branch", async () => {
    const fx = await seedPersonal(suite.sql);
    initCore({ ...process.env, PAYMENT_ENABLED: "false", INTERNAL_API_ENABLED: "true", INTERNAL_API_SECRET: "internal-secret-current-0123456789abcdef", INTERNAL_API_SECRET_PREVIOUS: "internal-secret-previous-0123456789abcdef" });
    try {
      expect(await db.transaction((tx) => creditLotService.grantTrialCredits({ userId: fx.userId, studioId: fx.studioId, credits: 50 }, tx))).toBe(null);
      expect(await suite.sql`select id from credit_sources where id=${fx.userId}`).toEqual([]);
      expect(await suite.sql`select id from credit_lots where user_id=${fx.userId}`).toEqual([]);
    } finally { initInternalCore(); }
  });

  it.each(["compensation", "gift"] as const)("P18 keeps the personal Studio non-transferable after a %s", async (kind) => {
    const fx = await seedPersonal(suite.sql);
    const receiver = await seedPersonal(suite.sql);
    const result = applied(await postGrant(suite, fx, grantKey(), grantBody(fx, { kind })));
    await expect(requestTransfer(fx.studioSlug, fx.userId, receiver.userId)).rejects.toMatchObject({ statusCode: 403 });
    expect(await suite.sql`select designated_studio_id from credit_lots where id=${result.lotId}`).toEqual([{ designated_studio_id: fx.studioId }]);
    expect(await lotState(result.lotId)).toEqual({ lifecycle: "active", remaining: "100.000000", ledger: "100.000000" });
  });

  it("P25 repays a purchased designation and retains the purchased same-Studio early return", async () => {
    const fx = await seedPersonal(suite.sql);
    const lotId = await exactUnassignedPurchase(fx, "100.000000");
    await seedDebt(suite.sql, fx, "20.000000");
    await creditLotService.designateLot({ lotId, requestingUserId: fx.userId, studioId: fx.studioId });
    expect(await lotState(lotId)).toEqual({ lifecycle: "active", remaining: "80.000000", ledger: "80.000000" });
    expect(await suite.sql`select amount::text from studio_credit_debts where studio_id=${fx.studioId}`).toEqual([{ amount: "0.000000" }]);
    await seedDebt(suite.sql, fx, "10.000000");
    const before = await suite.sql`select id from credit_ledger where lot_id=${lotId} order by id`;
    await creditLotService.designateLot({ lotId, requestingUserId: fx.userId, studioId: fx.studioId });
    expect(await lotState(lotId)).toEqual({ lifecycle: "active", remaining: "80.000000", ledger: "80.000000" });
    expect(await suite.sql`select amount::text from studio_credit_debts where studio_id=${fx.studioId}`).toEqual([{ amount: "10.000000" }]);
    expect(await suite.sql`select id from credit_ledger where lot_id=${lotId} order by id`).toEqual(before);
  });

  it.each(["100.000000", "9007199254.740000"])("P25 restores a booked refund of %s exactly", async (credits) => {
    const fx = await seedPersonal(suite.sql);
    const lotId = await exactUnassignedPurchase(fx, credits);
    await creditLotService.requestRefund({ lotId, requestingUserId: fx.userId });
    await db.transaction((tx) => creditLotService.settleRefund({ lotId, refundId: `test-refund-${randomUUID()}` }, tx));
    expect(await lotState(lotId)).toEqual({ lifecycle: "refunded", remaining: "0.000000", ledger: "0.000000" });
    await db.transaction((tx) => creditLotService.restoreRefundedCredits({ lotId, operationId: randomUUID() }, tx));
    expect(await lotState(lotId)).toEqual({ lifecycle: "active", remaining: credits, ledger: credits });
  });

  it.each(["100.000000", "9007199254.740000"])("P25 restores an unbooked failed refund of %s without adding credits", async (credits) => {
    const fx = await seedPersonal(suite.sql);
    const lotId = await exactUnassignedPurchase(fx, credits);
    await creditLotService.requestRefund({ lotId, requestingUserId: fx.userId });
    await db.transaction((tx) => creditLotService.restoreRefundedCredits({ lotId, operationId: randomUUID() }, tx));
    expect(await lotState(lotId)).toEqual({ lifecycle: "active", remaining: credits, ledger: credits });
    expect(await suite.sql`select amount::text from credit_ledger where lot_id=${lotId} and entry_type='refund_reversed'`).toEqual([{ amount: "0.000000" }]);
  });
});
