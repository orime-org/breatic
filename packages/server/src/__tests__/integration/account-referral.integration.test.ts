// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { initCore, loadLocales } from "@breatic/core";

const stripe = { checkout: { sessions: { list: vi.fn(), expire: vi.fn() } } };
vi.mock("@server/infra/stripe.js", () => ({ getStripeClient: () => stripe }));

import { bindLater, readAccountReferral } from "@server/modules/referral/referral.service";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  initCore(process.env);
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false, connection: { application_name: "account-referral-test" } });
});
afterAll(async () => { await sql?.end({ timeout: 1 }); });
beforeEach(() => {
  vi.clearAllMocks();
  stripe.checkout.sessions.list.mockResolvedValue({ data: [] });
  stripe.checkout.sessions.expire.mockResolvedValue({});
});

/**
 * Inserts an account.
 * @param customer - A Stripe customer id to store, if any.
 * @returns Its id.
 */
async function account(customer: string | null = null): Promise<string> {
  const id = randomUUID();
  await sql`insert into users(id,email,stripe_customer_id) values(${id},${`${id}@example.test`},${customer})`;
  return id;
}

/**
 * Makes an account an approved promoter with a code in the given status.
 * @param status - The code's status.
 * @returns The promoter and the code.
 */
async function promoter(status: "active" | "disabled" | "removed" = "active"): Promise<{ userId: string; code: string }> {
  const userId = await account();
  const code = `R${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
  const [app] = await sql<{ id: string }[]>`insert into promoter_applications
    (user_id,status,country,channels,plan,terms_version,terms_accepted_at,decided_at,decided_by)
    values(${userId},'approved','US',${sql.json(["x"])},'p','2026-11-07',now(),now(),'admin_7') returning id`;
  await sql`insert into referral_codes(code,promoter_id,application_id,status,removed_at)
    values(${code},${userId},${app!.id},${status},${status === "removed" ? new Date() : null})`;
  return { userId, code };
}

describe("readAccountReferral", () => {
  it("offers a fresh account the backfill and the application", async () => {
    const userId = await account();
    expect(await readAccountReferral(userId, "2026-11-07")).toEqual({
      firstPeriodDiscountPercent: 20,
      binding: null,
      canBind: true,
      program: { open: true, termsVersion: "2026-11-07" },
      promoter: { state: "none" },
    });
  });

  it("shows a bound account its code and pending discount, and no backfill", async () => {
    const { code } = await promoter();
    const userId = await account();
    await bindLater(userId, code);
    const view = await readAccountReferral(userId, "");
    expect(view.binding).toEqual({ code, discountPending: true });
    expect(view.canBind).toBe(false);
    expect(view.program).toEqual({ open: false, termsVersion: "" });
  });

  it("shows a promoter their code, link and status, including after removal", async () => {
    for (const status of ["active", "disabled", "removed"] as const) {
      const { userId, code } = await promoter(status);
      const view = await readAccountReferral(userId, "2026-11-07");
      expect(view.promoter).toMatchObject({ state: "approved", code, codeStatus: status });
      expect((view.promoter as { link: string }).link).toMatch(new RegExp(`/register\\?ref=${code}$`));
    }
  });

  it("shows a pending applicant when they applied, and a rejected one the note", async () => {
    const userId = await account();
    await sql`insert into promoter_applications(user_id,status,country,channels,plan,terms_version,terms_accepted_at)
      values(${userId},'pending','US',${sql.json(["x"])},'p','2026-11-07',now())`;
    expect((await readAccountReferral(userId, "2026-11-07")).promoter).toMatchObject({ state: "pending" });
    await sql`update promoter_applications set status='rejected',decided_at=now(),decided_by='admin_7',applicant_note='Links broken' where user_id=${userId}`;
    expect((await readAccountReferral(userId, "2026-11-07")).promoter).toMatchObject({ state: "rejected", note: "Links broken" });
  });
});

describe("bindLater", () => {
  it("binds with source later and expires the account's open membership checkouts", async () => {
    const { code } = await promoter();
    const userId = await account(`cus_${randomUUID().slice(0, 8)}`);
    stripe.checkout.sessions.list.mockResolvedValue({
      data: [{ id: "cs_sub", mode: "subscription" }, { id: "cs_pack", mode: "payment" }],
    });
    expect(await bindLater(userId, code)).toEqual({ ok: true });
    const [row] = await sql`select source from referral_bindings where user_id = ${userId}`;
    expect(row!.source).toBe("later");
    expect(stripe.checkout.sessions.expire).toHaveBeenCalledTimes(1);
    expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith("cs_sub", {}, expect.objectContaining({ maxNetworkRetries: 0 }));
  });

  it("leaves a discounted membership checkout open: it was made after the binding", async () => {
    const { code } = await promoter();
    const userId = await account(`cus_${randomUUID().slice(0, 8)}`);
    stripe.checkout.sessions.list.mockResolvedValue({
      data: [
        { id: "cs_discounted", mode: "subscription", discounts: [{ coupon: "referral-first-period-20", promotion_code: null }] },
        { id: "cs_full", mode: "subscription", discounts: [] },
        { id: "cs_pack", mode: "payment", discounts: [] },
      ],
    });
    expect(await bindLater(userId, code)).toEqual({ ok: true });
    expect(stripe.checkout.sessions.expire.mock.calls.map((c) => c[0])).toEqual(["cs_full"]);
  });

  it("keeps the binding when expiring the checkouts fails", async () => {
    const { code } = await promoter();
    const userId = await account(`cus_${randomUUID().slice(0, 8)}`);
    stripe.checkout.sessions.list.mockRejectedValue(new Error("Stripe down"));
    expect(await bindLater(userId, code)).toEqual({ ok: true });
    expect(await sql`select 1 from referral_bindings where user_id = ${userId}`).toHaveLength(1);
  });

  it("touches no checkout when the code is refused", async () => {
    const userId = await account(`cus_${randomUUID().slice(0, 8)}`);
    expect(await bindLater(userId, "NOSUCHCODE")).toEqual({ ok: false, reason: "invalid_code" });
    expect(stripe.checkout.sessions.list).not.toHaveBeenCalled();
  });
});
