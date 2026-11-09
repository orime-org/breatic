// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { initCore, loadLocales } from "@breatic/core";

/** Holds the next session create until the test lets it go. */
const held: { next: boolean; started?: () => void; release?: () => void } = { next: false };
const stripe = {
  checkout: {
    sessions: {
      list: vi.fn(),
      expire: vi.fn(),
      create: vi.fn(),
    },
  },
  coupons: { retrieve: vi.fn(), create: vi.fn() },
};
vi.mock("@server/infra/stripe.js", () => ({ getStripeClient: () => stripe }));

import { bindLater } from "@server/modules/referral/referral.service";
import { startCheckout } from "@server/modules/subscription/subscription.service";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  initCore(process.env);
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false, connection: { application_name: "referral-checkout-test" } });
});
afterAll(async () => { await sql?.end({ timeout: 1 }); });
beforeEach(() => {
  vi.clearAllMocks();
  held.next = false;
  stripe.checkout.sessions.list.mockResolvedValue({ data: [] });
  stripe.checkout.sessions.expire.mockResolvedValue({});
  stripe.coupons.retrieve.mockResolvedValue({ id: "referral-first-period-20", percent_off: 20, duration: "once", valid: true });
  let n = 0;
  stripe.checkout.sessions.create.mockImplementation(async () => {
    n += 1;
    const id = `cs_${n}`;
    if (held.next) {
      held.next = false;
      held.started?.();
      await new Promise<void>((resolve) => { held.release = resolve; });
    }
    return { id, url: `https://checkout.stripe.test/${id}` };
  });
});

/**
 * An account with a Stripe customer and an active code it could bind.
 * @returns The account and the code.
 */
async function unboundWithCode(): Promise<{ userId: string; code: string }> {
  const promoterId = randomUUID();
  await sql`insert into users(id,email) values(${promoterId},${`${promoterId}@example.test`})`;
  const [app] = await sql<{ id: string }[]>`insert into promoter_applications
    (user_id,status,country,channels,plan,terms_version,terms_accepted_at,decided_at,decided_by)
    values(${promoterId},'approved','US',${sql.json(["x"])},'p','2026-11-07',now(),now(),'admin_7') returning id`;
  const code = `K${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
  await sql`insert into referral_codes(code,promoter_id,application_id) values(${code},${promoterId},${app!.id})`;
  const userId = randomUUID();
  await sql`insert into users(id,email,stripe_customer_id) values(${userId},${`${userId}@example.test`},${`cus_${userId.slice(0, 8)}`})`;
  return { userId, code };
}

describe("a membership checkout and a backfill at the same time", () => {
  it("hands the buyer a discounted page when the code is bound while the page is being made", async () => {
    const { userId, code } = await unboundWithCode();
    const started = new Promise<void>((resolve) => { held.started = resolve; });
    held.next = true;
    const checkout = startCheckout({ userId, tier: "pro", period: "month", returnUrl: "http://localhost/studio" });
    await started;
    expect(await bindLater(userId, code)).toEqual({ ok: true });
    held.release!();

    const { url } = await checkout;
    const calls = stripe.checkout.sessions.create.mock.calls.map((c) => c[0] as { discounts?: unknown });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.discounts).toBeUndefined();
    expect(calls[1]!.discounts).toEqual([{ coupon: "referral-first-period-20" }]);
    expect(url).toBe("https://checkout.stripe.test/cs_2");
  });

  it("makes one page when nothing changes while it is being made", async () => {
    const { userId } = await unboundWithCode();
    const { url } = await startCheckout({ userId, tier: "pro", period: "month", returnUrl: "http://localhost/studio" });
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    expect(url).toBe("https://checkout.stripe.test/cs_1");
  });
});
