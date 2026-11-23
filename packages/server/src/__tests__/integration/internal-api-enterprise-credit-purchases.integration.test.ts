// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { initCore } from "@breatic/core";
import { creditLotService } from "@breatic/domain";
import { call, initInternalCore, useInternalApp } from "./internal-api-harness.js";
import { GRANT_ADMIN, seedDebt, seedPersonal } from "./operator-credit-grant-fixtures.js";
import { ENTERPRISE_BODY, enterpriseFixture, expectPurchase, postPurchase, purchaseKey, purchaseOperationPath, purchasePath } from "./enterprise-credit-purchase.fixture.js";

const suite = useInternalApp("enterprise-credit-purchases");

describe("enterprise credit purchase signed API", () => {
  it("reads current active enterprise and its contract revision", async () => {
    const fx = await enterpriseFixture(suite);
    const response = await call(suite.baseUrl, `${purchasePath(fx.userId)}/profile`, { admin: GRANT_ADMIN });
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ account: { id: fx.userId, email: fx.email }, enterpriseState: "active", revision: 1, contractNumber: ENTERPRISE_BODY.expectedContractNumber, expiresAt: "2099-01-01T00:00:00.000Z", canPurchase: true, reason: null });
  });

  it("creates a precise unassigned purchase without repaying a Studio at creation", async () => {
    const fx = await enterpriseFixture(suite);await seedDebt(suite.sql, fx, "20.000000");
    const key = purchaseKey();
    await expectPurchase(suite, fx.userId, key, await postPurchase(suite, fx.userId, key));
    expect(await suite.sql`select amount::text from studio_credit_debts where studio_id=${fx.studioId}`).toEqual([{ amount: "20.000000" }]);
  });

  it.each(["ordinary", "expired", "missing"])("retains a finite original refusal for %s enterprise state", async state => {
    const fx = await enterpriseFixture(suite);
    if (state === "ordinary") await suite.sql`update users set membership_tier='base' where id=${fx.userId}`;
    if (state === "expired") await suite.sql`update enterprise_memberships set expires_at='2020-01-01' where user_id=${fx.userId}`;
    if (state === "missing") await suite.sql`update enterprise_memberships set deleted_at=now() where user_id=${fx.userId}`;
    const code = state === "ordinary" ? "not_enterprise" : state === "expired" ? "enterprise_expired" : "enterprise_missing";
    const profile = await call(suite.baseUrl, `${purchasePath(fx.userId)}/profile`, { admin: GRANT_ADMIN });
    expect(profile.status).toBe(200);expect(profile.json).toMatchObject({ enterpriseState: state, canPurchase: false, reason: code });
    const key = purchaseKey();const refused = await postPurchase(suite, fx.userId, key);
    expect(refused.status).toBe(200);expect(refused.json).toMatchObject({ status: "refused", code });
    expect(await suite.sql`select id from credit_lots where user_id=${fx.userId}`).toEqual([]);
    expect((await call(suite.baseUrl, purchaseOperationPath(key), { admin: GRANT_ADMIN })).json).toEqual(refused.json);
    await suite.sql`update users set membership_tier='enterprise' where id=${fx.userId}`;
    await suite.sql`update enterprise_memberships set deleted_at=null,expires_at='2099-01-01' where user_id=${fx.userId}`;
    expect((await postPurchase(suite, fx.userId, key)).json).toEqual(refused.json);
  });

  it.each([{ expectedEnterpriseRevision: 2 }, { expectedContractNumber: "CHANGED" }])("persists contract snapshot refusal %#", async change => {
    const fx = await enterpriseFixture(suite);const key = purchaseKey();
    const response = await postPurchase(suite, fx.userId, key, { ...ENTERPRISE_BODY, ...change });
    expect(response.status).toBe(200);expect(response.json).toMatchObject({ status: "refused", code: "enterprise_changed" });
    expect(await suite.sql`select id from credit_lots where user_id=${fx.userId}`).toEqual([]);
  });

  it("replays the exact creation result after expiry and after designation", async () => {
    const fx = await enterpriseFixture(suite);const key = purchaseKey();
    const response = await postPurchase(suite, fx.userId, key);await expectPurchase(suite, fx.userId, key, response);
    await creditLotService.designateLot({ lotId: response.json.lotId, requestingUserId: fx.userId, studioId: fx.studioId });
    await suite.sql`update enterprise_memberships set expires_at='2020-01-01' where user_id=${fx.userId}`;
    expect(await creditLotService.designateLot({ lotId: response.json.lotId, requestingUserId: fx.userId, studioId: null })).toMatchObject({ designatedStudioId: null, remainingCredits: "100.050000" });
    expect(await creditLotService.designateLot({ lotId: response.json.lotId, requestingUserId: fx.userId, studioId: fx.studioId })).toMatchObject({ designatedStudioId: fx.studioId, remainingCredits: "100.050000" });
    expect((await postPurchase(suite, fx.userId, key)).json).toEqual(response.json);
    expect((await call(suite.baseUrl, purchaseOperationPath(key), { admin: GRANT_ADMIN })).json).toEqual(response.json);
    expect(await suite.sql`select id from credit_lots where user_id=${fx.userId}`).toHaveLength(1);
    const next = await postPurchase(suite, fx.userId, purchaseKey());
    expect(next.json).toMatchObject({ status: "refused", code: "enterprise_expired" });
  });

  it.each(["body", "account", "operator"])("refuses another %s under the same original key", async change => {
    const fx = await enterpriseFixture(suite);const key = purchaseKey();
    await expectPurchase(suite, fx.userId, key, await postPurchase(suite, fx.userId, key));
    const response = await postPurchase(suite, change === "account" ? randomUUID() : fx.userId, key,
      change === "body" ? { ...ENTERPRISE_BODY, credits: "200.00" } : ENTERPRISE_BODY, change === "operator" ? randomUUID() : GRANT_ADMIN);
    expect(response.status).toBe(409);expect(response.json).toEqual({ code: "idempotency_conflict" });
    expect(await suite.sql`select id from credit_lots where user_id=${fx.userId}`).toHaveLength(1);
  });

  it("retains account-not-found as a known original decision", async () => {
    const userId = randomUUID();const key = purchaseKey();const response = await postPurchase(suite, userId, key);
    expect(response.status).toBe(200);expect(response.json).toMatchObject({ status: "refused", code: "account_not_found" });
    expect((await call(suite.baseUrl, purchaseOperationPath(key), { admin: GRANT_ADMIN })).json).toEqual(response.json);
  });

  it("keeps absent profile and absent original decision explicit", async () => {
    expect((await call(suite.baseUrl, `${purchasePath(randomUUID())}/profile`, { admin: GRANT_ADMIN })).status).toBe(404);
    expect((await call(suite.baseUrl, purchaseOperationPath(purchaseKey()), { admin: GRANT_ADMIN })).status).toBe(404);
  });

  it("retains the payment-disabled decision and recovers the original result", async () => {
    const fx = await enterpriseFixture(suite);
    initCore({ ...process.env, PAYMENT_ENABLED: "false", INTERNAL_API_ENABLED: "true", INTERNAL_API_SECRET: "internal-secret-current-0123456789abcdef" });
    try {
      const response = await postPurchase(suite, fx.userId, purchaseKey());
      expect(response.status).toBe(200);expect(response.json).toMatchObject({ status: "refused", code: "payments_disabled" });
      expect((await call(suite.baseUrl, `${purchasePath(fx.userId)}/profile`, { admin: GRANT_ADMIN })).json).toMatchObject({ enterpriseState: "active", canPurchase: false, reason: "payments_disabled" });
    } finally { initInternalCore(); }
  });

  it.each([{ credits: "0" }, { credits: "1.001" }, { credits: "1e2" }, { reason: "" }, { reason: "bad\u0000reason" }, { expectedEnterpriseRevision: 0 }, { expectedContractNumber: "" }, { studioId: randomUUID() }])("rejects malformed intent before creating an operation %#", async change => {
    const fx = await enterpriseFixture(suite);const key = purchaseKey();
    const response = await postPurchase(suite, fx.userId, key, { ...ENTERPRISE_BODY, ...change });
    expect(response.status).toBe(422);
    expect((await call(suite.baseUrl, purchaseOperationPath(key), { admin: GRANT_ADMIN })).status).toBe(404);
    expect(await suite.sql`select id from credit_lots where user_id=${fx.userId}`).toEqual([]);
  });

  it("requires a valid signature on each enterprise endpoint", async () => {
    const fx = await seedPersonal(suite.sql);
    for (const path of [`${purchasePath(fx.userId)}/profile`, purchaseOperationPath(purchaseKey())]) {
      expect((await call(suite.baseUrl, path, { unsigned: true })).status).toBe(401);
    }
    expect((await call(suite.baseUrl, purchasePath(fx.userId), { body: ENTERPRISE_BODY, idempotencyKey: purchaseKey(), unsigned: true })).status).toBe(401);
  });
});
