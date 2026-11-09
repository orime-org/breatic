// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { initCore, loadLocales } from "@breatic/core";

import { firstPeriodDiscount } from "@server/modules/referral/referral.service";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  initCore(process.env);
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false, connection: { application_name: "referral-discount-test" } });
});
afterAll(async () => { await sql?.end({ timeout: 1 }); });

/**
 * Inserts an account on a raw tier.
 * @param tier - The stored membership tier.
 * @returns The account's id.
 */
async function account(tier = "base"): Promise<string> {
  const id = randomUUID();
  await sql`insert into users(id,email,membership_tier) values(${id},${`${id}@example.test`},${tier})`;
  return id;
}

/**
 * Binds a fresh account to a fresh code in the given status.
 * @param status - The code's status after binding.
 * @param tier - The bound account's stored tier.
 * @returns The bound account and its code.
 */
async function bound(status: "active" | "disabled" | "removed" = "active", tier = "base"): Promise<{ userId: string; code: string }> {
  const promoterId = await account();
  const code = `D${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
  const [app] = await sql<{ id: string }[]>`insert into promoter_applications
    (user_id,status,country,channels,plan,terms_version,terms_accepted_at,decided_at,decided_by)
    values(${promoterId},'approved','SG',${sql.json(["a channel"])},'plan','2026-11-07',now(),now(),'admin_7') returning id`;
  const [row] = await sql<{ id: string }[]>`insert into referral_codes(code,promoter_id,application_id,status,removed_at)
    values(${code},${promoterId},${app!.id},${status},${status === "removed" ? new Date() : null}) returning id`;
  const userId = await account(tier);
  await sql`insert into referral_bindings(user_id,referral_code_id,source) values(${userId},${row!.id},'later')`;
  return { userId, code };
}

describe("firstPeriodDiscount", () => {
  it("is null for an account that carries no code", async () => {
    expect(await firstPeriodDiscount(await account())).toBeNull();
  });

  it("is the bound code and the configured percent for an account that never paid", async () => {
    const { userId, code } = await bound();
    expect(await firstPeriodDiscount(userId)).toEqual({ code, percent: 20 });
  });

  it.each(["disabled", "removed"] as const)("survives the code being %s afterwards", async (status) => {
    const { userId, code } = await bound(status);
    expect(await firstPeriodDiscount(userId)).toEqual({ code, percent: 20 });
  });

  it("ends once a membership has been paid for", async () => {
    const { userId } = await bound();
    await sql`insert into subscriptions(user_id,stripe_subscription_id,tier,period,status,current_period_end,first_active_at)
      values(${userId},${`sub_disc_${randomUUID()}`},'pro','month','active',now() + interval '20 days',now())`;
    expect(await firstPeriodDiscount(userId)).toBeNull();
  });

  it("is null while a live enterprise membership is in force", async () => {
    const { userId } = await bound("active", "enterprise");
    await sql`insert into enterprise_memberships(user_id,expires_at,entry_timezone,contract_number,team_studios,projects_per_studio,concurrent_editors,studio_members,project_members,storage_bytes,fallback_tier,revision)
      values(${userId},${new Date(Date.now() + 86_400_000)},'UTC','TEST-DISC-1',8,20,30,200,80,1099511627776,'base',1)`;
    expect(await firstPeriodDiscount(userId)).toBeNull();
  });
});
