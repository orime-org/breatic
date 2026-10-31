// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { randomBytes, randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { db, getRedis, sessionCookieName, setSession } from "@breatic/core";
import { creditHoldService, creditLotService } from "@breatic/domain";
import * as shared from "@breatic/shared";
import * as paymentService from "@server/modules/payment/payment.service.js";
import { getConfirmationView } from "@server/modules/payment/payment.repo.js";
import { renderPurchaseConfirmation } from "@server/modules/payment/purchase-mail-template.js";
import { useInternalApp } from "./internal-api-harness.js";
import { seedDesignatedLot } from "./studio-credit-fixtures.js";
import { applied, grantBody, grantKey, postGrant, seedPersonal } from "./operator-credit-grant-fixtures.js";
import type { PersonalFixture } from "./operator-credit-grant-fixtures.js";

const suite = useInternalApp("credit-amount-format");
let app: Hono;
beforeAll(async () => { const module = await import("@server/app.js"); app = module.createApp(); });
interface RuntimeSchema { parse: (value: unknown) => unknown }

/** Obtain the agreed runtime parser from the existing shared public entry. */
function parseView(name: string, value: unknown): unknown {
  const schema = (shared as unknown as Record<string, RuntimeSchema | undefined>)[name];
  expect(typeof schema?.parse, `${name} must be exported`).toBe("function");
  return schema!.parse(value);
}

/** Create a real session for this independently seeded account. */
async function cookieFor(userId: string): Promise<string> {
  const token = randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return `${sessionCookieName()}=${token}`;
}

/** The public amount readers for one valid account and its personal Studio. */
function readers(fx: PersonalFixture): { path: string; schema: string; paged: boolean }[] {
  return [
    { path: "/api/v1/credits/overview", schema: "creditOverviewSchema", paged: false },
    { path: "/api/v1/credits/lots", schema: "creditLotViewSchema", paged: true },
    { path: "/api/v1/credits/ledger", schema: "creditLedgerViewSchema", paged: true },
    { path: `/api/v1/projects/${fx.projectId}/credits`, schema: "projectCreditsViewSchema", paged: false },
    { path: `/api/v1/studio/${fx.studioSlug}/credits`, schema: "studioCreditsViewSchema", paged: false },
    { path: "/api/v1/payment/history", schema: "purchaseRowSchema", paged: true },
  ];
}

/** Read an authenticated envelope and assert its HTTP status before data access. */
async function read(path: string, cookie: string): Promise<Record<string, unknown>> {
  const response = await app.request(path, { headers: { cookie } });
  expect(response.status).toBe(200);
  const body = await response.json() as { data: Record<string, unknown> };
  return body.data;
}

describe("decimal-v1 amount format on the public readers", () => {
  it.each([0, 1, 2, 3, 4, 5])("P21 rejects a missing amount-format marker on reader %i", async (index) => {
    const fx = await seedPersonal(suite.sql);
    const cookie = await cookieFor(fx.userId);
    const response = await app.request(readers(fx)[index]!.path, { headers: { cookie } });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { reason: "request_shape" } });
  });

  it.each([0, 1, 2, 3, 4, 5])("P21 rejects an unsupported amount format on reader %i", async (index) => {
    const fx = await seedPersonal(suite.sql);
    const cookie = await cookieFor(fx.userId);
    const response = await app.request(`${readers(fx)[index]!.path}?amountFormat=decimal-v2`, { headers: { cookie } });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { reason: "request_shape" } });
  });

  it.each([0, 1, 2, 3, 4, 5])("P21 and P22 parse exact decimal data from reader %i", async (index) => {
    const fx = await seedPersonal(suite.sql);
    const original = applied(await postGrant(suite, fx, grantKey()));
    if (index === 2) await creditLotService.chargeForGeneration({ projectId: fx.projectId, actorUserId: fx.userId, amount: 0.01, referenceId: randomUUID() });
    const cookie = await cookieFor(fx.userId);
    const target = readers(fx)[index]!;
    const data = await read(`${target.path}?amountFormat=decimal-v1&limit=1`, cookie);
    if (target.paged) {
      const rows = data.items as Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      expect(parseView(target.schema, rows[0])).toEqual(rows[0]);
      if (index === 1) expect(rows[0]).toMatchObject({ id: original.lotId, remainingCredits: "100.000000", purchasedCredits: "100.000000" });
      if (index === 2) expect(rows[0]).toMatchObject({ kind: "generation", amount: "-0.010000" });
      if (index === 5) expect(rows[0]).toMatchObject({ creditsGranted: "100.000000", remainingCredits: "100.000000" });
    } else {
      expect(parseView(target.schema, data)).toEqual(data);
      if (index === 0) expect(data).toMatchObject({ assignedCredits: "100.000000", unassignedCredits: "0.000000", underRefundCredits: "0.000000" });
      else expect(data).toMatchObject({ spendable: "100.000000", held: "0.000000", available: "100.000000" });
    }
  });

  it("P21 refuses format mismatch before overview reconciliation", async () => {
    const fx = await seedPersonal(suite.sql);
    const cookie = await cookieFor(fx.userId);
    const reconcile = vi.spyOn(paymentService, "reconcilePayments");
    try {
      const response = await app.request("/api/v1/credits/overview?amountFormat=unknown", { headers: { cookie } });
      expect(response.status).toBe(422);
      expect(reconcile).toHaveBeenCalledTimes(0);
    } finally { reconcile.mockRestore(); }
  });

  it("P22 keeps the eleven-Studio aggregate and each Studio amount exact", async () => {
    const fx = await seedPersonal(suite.sql);
    await seedDesignatedLot(suite.sql, fx, 900000000);
    for (let index = 0; index < 10; index++) {
      const [studio] = await suite.sql<{ id: string }[]>`insert into studios(created_by_user_id,slug,type,name)
        values(${fx.userId},${`a-${randomUUID()}`},'team','Amount Studio') returning id`;
      await suite.sql`insert into studio_members(studio_id,user_id,role) values(${studio!.id},${fx.userId},'admin')`;
      await seedDesignatedLot(suite.sql, { ...fx, studioId: studio!.id }, 0.07);
    }
    const overview = await read("/api/v1/credits/overview?amountFormat=decimal-v1", await cookieFor(fx.userId));
    expect(overview).toMatchObject({ assignedCredits: "900000000.700000", unassignedCredits: "0.000000", underRefundCredits: "0.000000" });
    expect((overview.studios as { spendable: string }[]).map((row) => row.spendable).sort()).toEqual([...Array(10).fill("0.070000"), "900000000.000000"]);
    expect(parseView("creditOverviewSchema", overview)).toEqual(overview);
    for (const studio of overview.studios as Record<string, unknown>[]) expect(parseView("studioCreditSummarySchema", studio)).toEqual(studio);
  });

  it("P21 and P22 retain exact cursor pages and Studio continuation structure", async () => {
    const fx = await seedPersonal(suite.sql);
    applied(await postGrant(suite, fx, grantKey()));
    applied(await postGrant(suite, fx, grantKey(), grantBody(fx, { kind: "gift" })));
    for (let index = 0; index < 2; index++) await creditLotService.chargeForGeneration({ projectId: fx.projectId, actorUserId: fx.userId, amount: 0.01, referenceId: randomUUID() });
    const cookie = await cookieFor(fx.userId);
    for (const index of [1, 2, 5]) {
      const target = readers(fx)[index]!;
      const first = await read(`${target.path}?amountFormat=decimal-v1&limit=1`, cookie);
      expect(first.items).toHaveLength(1);
      expect(first.nextCursor).toEqual(expect.any(String));
      const next = await read(`${target.path}?amountFormat=decimal-v1&limit=1&cursor=${encodeURIComponent(first.nextCursor as string)}`, cookie);
      expect(next.items).toHaveLength(1);
      expect(next.nextCursor).toBe(null);
      const items = [...first.items as Record<string, unknown>[], ...next.items as Record<string, unknown>[]];
      expect(new Set(items.map((row) => row.id ?? row.rowId)).size).toBe(2);
      for (const row of items) expect(parseView(target.schema, row)).toEqual(row);
    }
    const path = `/api/v1/studio/${fx.studioSlug}/credits?amountFormat=decimal-v1&limit=1`;
    const first = await read(path, cookie);
    expect(first).toMatchObject({ spendable: "199.980000", debt: "0.000000", held: "0.000000", available: "199.980000" });
    for (const lot of first.lots as Record<string, unknown>[]) expect(parseView("studioLotViewSchema", lot)).toEqual(lot);
    const page = first.ledger as { items: Record<string, unknown>[]; nextCursor: string };
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(parseView("studioLedgerViewSchema", page.items[0])).toEqual(page.items[0]);
    const next = await read(`${path}&cursor=${encodeURIComponent(page.nextCursor)}`, cookie);
    expect(Object.keys(next)).toEqual(["ledger"]);
    expect(parseView("studioCreditsViewSchema", next)).toEqual(next);
    const continuation = next.ledger as { items: Record<string, unknown>[]; nextCursor: string | null };
    expect(continuation.items).toHaveLength(1);
    expect(continuation.items[0]!.id).not.toBe(page.items[0]!.id);
    expect(continuation.nextCursor).toBe(null);
    expect(parseView("studioLedgerViewSchema", continuation.items[0])).toEqual(continuation.items[0]);
  });

  it("P22 preserves empty monetary views and pending-payment null balances", async () => {
    const fx = await seedPersonal(suite.sql);
    const cookie = await cookieFor(fx.userId);
    for (const index of [0, 3, 4]) {
      const target = readers(fx)[index]!;
      const data = await read(`${target.path}?amountFormat=decimal-v1`, cookie);
      expect(parseView(target.schema, data)).toEqual(data);
      if (index === 0) expect(data).toMatchObject({ assignedCredits: "0.000000", unassignedCredits: "0.000000", underRefundCredits: "0.000000" });
      else expect(data).toMatchObject({ spendable: "0.000000", held: "0.000000", available: "0.000000" });
    }
    const id = randomUUID();
    await suite.sql`insert into credit_sources(id,kind) values(${id},'payment')`;
    await suite.sql`insert into payments(id,user_id,amount_cents,credits_granted,status) values(${id},${fx.userId},1000,100,'pending')`;
    const history = await read("/api/v1/payment/history?amountFormat=decimal-v1", cookie);
    expect(history.items).toHaveLength(1);
    const row = (history.items as Record<string, unknown>[])[0]!;
    expect(row).toMatchObject({ rowId: id, paymentId: id, creditsGranted: "100.000000", remainingCredits: null, lifecycle: null, amountCents: 1000 });
    expect(parseView("purchaseRowSchema", row)).toEqual(row);
  });

  it("P23 keeps history and confirmation-mail balances exact across purchased and granted sources", async () => {
    const fx = await seedPersonal(suite.sql);
    const paidLot = await seedDesignatedLot(suite.sql, fx, 1);
    const [lot] = await suite.sql<{ source_id: string }[]>`select source_id from credit_lots where id=${paidLot}`;
    await suite.sql`update payments set total_cents=1300,tax_cents=300 where id=${lot!.source_id}`;
    const first = applied(await postGrant(suite, fx, grantKey(), grantBody(fx, { credits: "9007199253.74" })));
    const second = applied(await postGrant(suite, fx, grantKey(), grantBody(fx, { kind: "gift", credits: "9007199254.73" })));
    const history = await read("/api/v1/payment/history?amountFormat=decimal-v1", await cookieFor(fx.userId));
    const rows = history.items as Record<string, unknown>[];
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.rowId === first.lotId)).toMatchObject({ sourceKind: "compensation", creditsGranted: "9007199253.740000", remainingCredits: "9007199253.740000", amountCents: null });
    expect(rows.find((row) => row.rowId === second.lotId)).toMatchObject({ sourceKind: "gift", creditsGranted: "9007199254.730000", remainingCredits: "9007199254.730000", amountCents: null });
    const paid = rows.find((row) => row.paymentId === lot!.source_id)!;
    expect(paid).toMatchObject({ rowId: lot!.source_id, sourceKind: "payment", amountCents: 1000, totalCents: 1300, taxCents: 300, creditsGranted: "1.000000", remainingCredits: "1.000000" });
    for (const row of rows) expect(parseView("purchaseRowSchema", row)).toEqual(row);
    const view = await getConfirmationView(lot!.source_id);
    expect(view?.balanceCredits).toBe("18014398509.470000");
    expect(view).toMatchObject({ amountCents: 1000, currency: "usd" });
    const mail = await renderPurchaseConfirmation(view!);
    expect(mail.text).toMatch(/18,014,398,509\.47|18014398509\.47(?:0000)?/);
    expect(mail.html).toMatch(/18,014,398,509\.47|18014398509\.47(?:0000)?/);
  });

  it("P24 admits exactly one remaining cent under concurrent reservations", async () => {
    const fx = await seedPersonal(suite.sql);
    applied(await postGrant(suite, fx, grantKey(), grantBody(fx, { credits: "99999999999999.99" })));
    const initial = `initial-${randomUUID()}`;
    await suite.sql`insert into credit_holds(studio_id,actor_user_id,reference_id,amount,status,expires_at)
      values(${fx.studioId},${fx.userId},${initial},99999999999999.98,'held',now()+interval '1 hour')`;
    const references = [randomUUID(), randomUUID()];
    try {
      const outcomes = await Promise.all(references.map((referenceId) => creditHoldService.reserveCredits({ projectId: fx.projectId, actorUserId: fx.userId, referenceId, amount: 0.01, ttlMs: 3600000 })));
      expect(outcomes.map((row) => row.ok).sort()).toEqual([false, true]);
      const held = await suite.sql<{ reference_id: string; amount: string }[]>`select reference_id,amount::text from credit_holds where reference_id in ${suite.sql(references)} and status='held'`;
      expect(held).toHaveLength(1);
      expect(held[0]!.amount).toBe("0.010000");
      const charge = await creditLotService.chargeForGeneration({ projectId: fx.projectId, actorUserId: fx.userId, amount: 0.01, referenceId: randomUUID(), releaseHold: held[0]!.reference_id });
      expect(charge).toMatchObject({ charged: "0.010000", shortfall: "0.000000" });
      expect(await suite.sql`select status from credit_holds where reference_id=${held[0]!.reference_id}`).toEqual([{ status: "released" }]);
      expect(await suite.sql`select remaining_credits::text as remaining from credit_lots where user_id=${fx.userId}`).toEqual([{ remaining: "99999999999999.980000" }]);
    } finally {
      for (const reference of [initial, ...references]) await creditHoldService.releaseHold(reference);
    }
  });
  it("B16 carries registration and operator gift origins through exact public reads", async () => {
    const fx = await seedPersonal(suite.sql);
    await db.transaction((tx) => creditLotService.grantTrialCredits({ userId: fx.userId, studioId: fx.studioId, credits: 50 }, tx));
    const operator = applied(await postGrant(suite, fx, grantKey(), grantBody(fx, { kind: "gift", credits: "50.00" })));
    const registrations = await suite.sql<{ id: string }[]>`select id from credit_lots where source_id=${fx.userId} and user_id=${fx.userId}`;
    expect(registrations).toHaveLength(1);
    const registration = registrations[0]!;
    const cookie = await cookieFor(fx.userId);
    const history = await read("/api/v1/payment/history?amountFormat=decimal-v1", cookie);
    const purchases = history.items as Record<string, unknown>[];
    expect(purchases).toHaveLength(2);
    expect(purchases.find((row) => row.rowId === registration.id)).toMatchObject({ sourceKind: "gift", giftOrigin: "registration", creditsGranted: "50.000000" });
    expect(purchases.find((row) => row.rowId === operator.lotId)).toMatchObject({ sourceKind: "gift", giftOrigin: "operator", creditsGranted: "50.000000" });
    for (const row of purchases) expect(parseView("purchaseRowSchema", row)).toEqual(row);
    const page = await read("/api/v1/credits/lots?amountFormat=decimal-v1", cookie);
    const lots = page.items as Record<string, unknown>[];
    expect(lots).toHaveLength(2);
    expect(lots.find((row) => row.id === registration.id)).toMatchObject({ sourceKind: "gift", giftOrigin: "registration", purchasedCredits: "50.000000" });
    expect(lots.find((row) => row.id === operator.lotId)).toMatchObject({ sourceKind: "gift", giftOrigin: "operator", purchasedCredits: "50.000000" });
    for (const row of lots) expect(parseView("creditLotViewSchema", row)).toEqual(row);
  });

  it("returns a full exact lot view after the existing purchased designation action", async () => {
    const fx = await seedPersonal(suite.sql);
    const lotId = await seedDesignatedLot(suite.sql, fx, 100);
    const cookie = await cookieFor(fx.userId);
    const response = await app.request(`/api/v1/credits/lots/${lotId}/designation`, {
      method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ studioId: fx.studioId }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({ id: lotId, sourceKind: "payment", purchasedCredits: "100.000000", remainingCredits: "100.000000", designatedStudioId: fx.studioId });
    expect(parseView("creditLotViewSchema", body.data)).toEqual(body.data);
    expect(body.data.designatedStudioName).toEqual(expect.any(String));
    expect(body.data.designated).toBe(true);
  });

});
