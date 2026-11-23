// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, inject, it } from "vitest";
import { creditLotRepo, creditLotService } from "@breatic/domain";
import { call, useInternalApp } from "./internal-api-harness.js";
import { GRANT_ADMIN, seedDebt, seedPersonal } from "./operator-credit-grant-fixtures.js";
import { enterpriseFixture, expectPurchase, postPurchase, purchaseKey, purchaseOperationPath } from "./enterprise-credit-purchase.fixture.js";
import { waitUntilBlockedOn } from "./lock-probe.js";
import * as creditView from "@server/modules/credit/credit-view.service.js";
import { getPurchaseHistory } from "@server/modules/payment/payment.service.js";

const suite = useInternalApp("enterprise-credit-engine");

describe("enterprise credit purchase engine and projections", () => {
  it("projects the immutable contract through history, lots and Studio funds", async () => {
    const fx = await enterpriseFixture(suite);const key = purchaseKey();
    const response = await postPurchase(suite, fx.userId, key);await expectPurchase(suite, fx.userId, key, response);
    await suite.sql`update enterprise_memberships set contract_number='A LATER CONTRACT',revision=2 where user_id=${fx.userId}`;
    expect((await getPurchaseHistory(fx.userId, undefined, undefined)).items).toEqual([expect.objectContaining({ sourceKind: "enterprise", contractNumber: "ENTERPRISE-174", paymentId: null, amountCents: null, totalCents: null, canResend: false })]);
    expect(await creditView.getLot(fx.userId, response.json.lotId)).toMatchObject({ sourceKind: "enterprise", contractNumber: "ENTERPRISE-174" });
    expect((await creditView.listLots(fx.userId)).items).toEqual([expect.objectContaining({ sourceKind: "enterprise", contractNumber: "ENTERPRISE-174" })]);
    await creditLotService.designateLot({ lotId: response.json.lotId, requestingUserId: fx.userId, studioId: fx.studioId });
    expect((await creditView.getStudioCredits(fx.studioId)).lots).toEqual([expect.objectContaining({ sourceKind: "enterprise", contractNumber: "ENTERPRISE-174" })]);
  });

  it("designates personal and team funds, repays existing debt, and unassigns the remainder", async () => {
    const fx = await enterpriseFixture(suite);await seedDebt(suite.sql, fx, "20.000000");
    const response = await postPurchase(suite, fx.userId, purchaseKey());const lotId = response.json.lotId as string;
    expect(response.status).toBe(200);
    const personal = await creditLotService.designateLot({ lotId, requestingUserId: fx.userId, studioId: fx.studioId });
    expect(personal).toMatchObject({ designatedStudioId: fx.studioId, remainingCredits: "80.050000" });
    const [team] = await suite.sql<{ id: string }[]>`insert into studios(created_by_user_id,slug,type,name) values(${fx.userId},${randomUUID()},'team','Corporate team') returning id`;
    await suite.sql`insert into studio_members(studio_id,user_id,role) values(${team!.id},${fx.userId},'admin')`;
    expect(await creditLotService.designateLot({ lotId, requestingUserId: fx.userId, studioId: team!.id })).toMatchObject({ designatedStudioId: team!.id, remainingCredits: "80.050000" });
    expect(await creditLotService.designateLot({ lotId, requestingUserId: fx.userId, studioId: null })).toMatchObject({ designatedStudioId: null, remainingCredits: "80.050000" });
    expect(await suite.sql`select entry_type,amount::text,studio_id from credit_ledger where lot_id=${lotId} order by created_at`).toEqual([
      { entry_type: "topup", amount: "100.050000", studio_id: null },
      { entry_type: "debt_repayment", amount: "-20.000000", studio_id: fx.studioId },
    ]);
    expect(await creditLotRepo.sumGrantedForUser(fx.userId)).toBe("0");
  });

  it("enforces the existing holder and Studio administrator permissions", async () => {
    const fx = await enterpriseFixture(suite);const other = await seedPersonal(suite.sql);
    const response = await postPurchase(suite, fx.userId, purchaseKey());expect(response.status).toBe(200);
    await expect(creditLotService.designateLot({ lotId: response.json.lotId, requestingUserId: fx.userId, studioId: other.studioId })).rejects.toMatchObject({ statusCode: 403 });
    await expect(creditLotService.designateLot({ lotId: response.json.lotId, requestingUserId: other.userId, studioId: null })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("routes a corporate purchase's financial refund to its offline contract", async () => {
    const fx = await enterpriseFixture(suite);const response = await postPurchase(suite, fx.userId, purchaseKey());expect(response.status).toBe(200);
    await expect(creditLotService.requestRefund({ lotId: response.json.lotId, requestingUserId: fx.userId })).rejects.toMatchObject({ statusCode: 422 });
    expect(await suite.sql`select lifecycle from credit_lots where id=${response.json.lotId}`).toEqual([{ lifecycle: "active" }]);
  });

  it.each(["credit_sources", "credit_enterprise_purchases", "credit_lots", "credit_ledger", "enterprise_credit_purchase_operations"])("rolls back the complete purchase if %s cannot insert", async table => {
    const fx = await enterpriseFixture(suite);const key = purchaseKey();const trigger = `purchase_fail_${randomUUID().replaceAll("-", "")}`;
    const sourceCount = await suite.sql`select count(*)::int as n from credit_sources`;
    const column = table === "credit_sources" ? "kind" : table === "credit_lots" ? "user_id" : table === "credit_ledger" ? "payer_user_id" : "target_user_id";
    const value = table === "credit_sources" ? "enterprise" : fx.userId;
    await suite.sql.unsafe(`create function ${trigger}() returns trigger language plpgsql as $$ begin if NEW.${column}::text='${value}' then raise exception 'injected enterprise purchase failure'; end if; return NEW; end $$`);
    try {
      await suite.sql.unsafe(`create trigger ${trigger} before insert on ${table} for each row execute function ${trigger}()`);
      try { expect((await postPurchase(suite, fx.userId, key)).status).toBe(500); }
      finally { await suite.sql.unsafe(`drop trigger ${trigger} on ${table}`); }
    } finally { await suite.sql.unsafe(`drop function ${trigger}()`); }
    expect(await suite.sql`select id from credit_lots where user_id=${fx.userId}`).toEqual([]);
    expect(await suite.sql`select count(*)::int as n from credit_sources`).toEqual(sourceCount);
    expect(await suite.sql`select id from credit_enterprise_purchases where target_user_id=${fx.userId}`).toEqual([]);
    expect(await suite.sql`select id from credit_ledger where payer_user_id=${fx.userId}`).toEqual([]);
    expect((await call(suite.baseUrl, purchaseOperationPath(key), { admin: GRANT_ADMIN })).status).toBe(404);
    await expectPurchase(suite, fx.userId, key, await postPurchase(suite, fx.userId, key));
  });

  it("serializes two observed original-key waiters into one purchase", async () => {
    const fx = await enterpriseFixture(suite);const key = purchaseKey();const gate = postgres(inject("DATABASE_URL"), { max: 1, prepare: false });
    let release: () => void = () => {};let acquired: () => void = () => {};
    const held = new Promise<void>(resolve => { acquired = resolve; });const allowed = new Promise<void>(resolve => { release = resolve; });
    const holding = gate.begin(async tx => { await tx`select pg_advisory_xact_lock(hashtext(${`enterprise-credit-purchase:${key}`}))`;acquired();await allowed; });
    await held;
    const first = postPurchase(suite, fx.userId, key);const second = postPurchase(suite, fx.userId, key);
    try { await waitUntilBlockedOn(suite.sql, ["pg_advisory_xact_lock"], 2); }
    finally { release();await holding;await gate.end({ timeout: 1 }); }
    const results = await Promise.all([first, second]);await expectPurchase(suite, fx.userId, key, results[0]);
    expect(results[1].json).toEqual(results[0].json);
    expect(await suite.sql`select id from credit_lots where user_id=${fx.userId}`).toHaveLength(1);
  });

  it.each(["contract", "expiry"])("reads the current %s after acquiring the existing account lock", async change => {
    const fx = await enterpriseFixture(suite);const gate = postgres(inject("DATABASE_URL"), { max: 1, prepare: false });
    let release: () => void = () => {};let acquired: () => void = () => {};
    const held = new Promise<void>(resolve => { acquired = resolve; });const allowed = new Promise<void>(resolve => { release = resolve; });
    const updating = gate.begin(async tx => {
      await tx`select id from users where id=${fx.userId} for update`;acquired();await allowed;
      if (change === "contract") await tx`update enterprise_memberships set contract_number='RENEGOTIATED',revision=2 where user_id=${fx.userId}`;
      else await tx`update enterprise_memberships set expires_at='2020-01-01' where user_id=${fx.userId}`;
    });
    await held;const pending = postPurchase(suite, fx.userId, purchaseKey());
    try { await waitUntilBlockedOn(suite.sql, ["users", "for update"]); }
    finally { release();await updating;await gate.end({ timeout: 1 }); }
    const response = await pending;expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ status: "refused", code: change === "contract" ? "enterprise_changed" : "enterprise_expired" });
    expect(await suite.sql`select id from credit_lots where user_id=${fx.userId}`).toEqual([]);
  });
});
