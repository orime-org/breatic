// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { randomUUID } from "node:crypto";
import fc from "fast-check";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { db, initCore, loadLocales } from "@breatic/core";

import { bindReferral } from "@server/modules/referral/referral-binding.service";
import { waitUntilBlockedOn } from "./lock-probe.js";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  initCore(process.env);
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false, connection: { application_name: "referral-binding-test" } });
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
 * Inserts an approved promoter with one code in the given status.
 * @param code - Stored form of the code.
 * @param status - The code's status.
 * @returns The promoter's account id.
 */
async function promoter(code: string, status: "active" | "disabled" | "removed" = "active"): Promise<string> {
  const userId = await account();
  const [app] = await sql<{ id: string }[]>`insert into promoter_applications
    (user_id,status,country,channels,plan,terms_version,terms_accepted_at,decided_at,decided_by)
    values(${userId},'approved','US',${sql.json(["https://example.test"])},'plan','2026-11-07',now(),now(),'admin_7') returning id`;
  await sql`insert into referral_codes(code,promoter_id,application_id,status,removed_at)
    values(${code},${userId},${app!.id},${status},${status === "removed" ? new Date() : null})`;
  return userId;
}

/** A fresh unique code in stored form. */
function freshCode(): string {
  return `T${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
}

/**
 * Binds inside one transaction, as every caller does.
 * @param userId - The account binding.
 * @param code - What was typed.
 * @param source - Where the code came from.
 * @returns The binding's outcome.
 */
async function bind(userId: string, code: string, source: "signup_link" | "signup_typed" | "later" = "later"): Promise<Awaited<ReturnType<typeof bindReferral>>> {
  return db.transaction((tx) => bindReferral({ userId, code, source }, tx));
}

/**
 * Reads an account's binding.
 * @param userId - The account.
 * @returns Its code and source, or null.
 */
async function bindingOf(userId: string): Promise<{ code: string; source: string } | null> {
  const [row] = await sql<{ code: string; source: string }[]>`select c.code, b.source from referral_bindings b
    join referral_codes c on c.id = b.referral_code_id where b.user_id = ${userId}`;
  return row ?? null;
}

describe("bindReferral", () => {
  it("binds an active code, in any case and with surrounding spaces, and records where it came from", async () => {
    const code = freshCode();
    await promoter(code);
    const userId = await account();
    expect(await bind(userId, `  ${code.toLowerCase()} `, "signup_link")).toEqual({ ok: true });
    expect(await bindingOf(userId)).toEqual({ code, source: "signup_link" });
  });

  it.each([
    ["a malformed code", "!!", "active"],
    ["an unknown code", "NOSUCHCODE1", null],
    ["a disabled code", "DISABLED", "disabled"],
    ["a removed code", "REMOVED", "removed"],
  ] as const)("refuses %s as invalid_code and writes nothing", async (_label, typed, status) => {
    let code = typed as string;
    if (status !== null && typed !== "!!") {
      code = freshCode();
      await promoter(code, status);
    }
    const userId = await account();
    expect(await bind(userId, code)).toEqual({ ok: false, reason: "invalid_code" });
    expect(await bindingOf(userId)).toBeNull();
  });

  it("refuses a second code as already_bound and keeps the first", async () => {
    const first = freshCode();
    const second = freshCode();
    await promoter(first);
    await promoter(second);
    const userId = await account();
    await bind(userId, first);
    expect(await bind(userId, second)).toEqual({ ok: false, reason: "already_bound" });
    expect((await bindingOf(userId))?.code).toBe(first);
  });

  it("judges the code before anything else: a disabled code on a bound account is invalid_code", async () => {
    const first = freshCode();
    const disabled = freshCode();
    await promoter(first);
    await promoter(disabled, "disabled");
    const userId = await account();
    await bind(userId, first);
    expect(await bind(userId, disabled)).toEqual({ ok: false, reason: "invalid_code" });
  });

  it("refuses an account under a live enterprise membership as not_eligible", async () => {
    const code = freshCode();
    await promoter(code);
    const userId = await account("enterprise");
    await sql`insert into enterprise_memberships(user_id,expires_at,entry_timezone,contract_number,team_studios,projects_per_studio,concurrent_editors,studio_members,project_members,storage_bytes,fallback_tier,revision)
      values(${userId},${new Date(Date.now() + 86_400_000)},'UTC','TEST-REF-1',8,20,30,200,80,1099511627776,'base',1)`;
    expect(await bind(userId, code)).toEqual({ ok: false, reason: "not_eligible" });
    expect(await bindingOf(userId)).toBeNull();
  });

  it("binds an account whose enterprise membership has expired and that never paid", async () => {
    const code = freshCode();
    await promoter(code);
    const userId = await account("enterprise");
    await sql`insert into enterprise_memberships(user_id,expires_at,entry_timezone,contract_number,team_studios,projects_per_studio,concurrent_editors,studio_members,project_members,storage_bytes,fallback_tier,revision)
      values(${userId},${new Date(Date.now() - 86_400_000)},'UTC','TEST-REF-2',8,20,30,200,80,1099511627776,'base',1)`;
    expect(await bind(userId, code)).toEqual({ ok: true });
  });

  it("refuses an account that has paid for a membership as already_paid", async () => {
    const code = freshCode();
    await promoter(code);
    const userId = await account("pro");
    await sql`insert into subscriptions(user_id,stripe_subscription_id,tier,period,status,current_period_end,first_active_at)
      values(${userId},${`sub_ref_${randomUUID()}`},'pro','month','canceled',now(),now() - interval '40 days')`;
    expect(await bind(userId, code)).toEqual({ ok: false, reason: "already_paid" });
    expect(await bindingOf(userId)).toBeNull();
  });

  it("binds an account whose only subscription never became active", async () => {
    const code = freshCode();
    await promoter(code);
    const userId = await account();
    await sql`insert into subscriptions(user_id,stripe_subscription_id,tier,period,status,current_period_end)
      values(${userId},${`sub_ref_${randomUUID()}`},'pro','month','incomplete_expired',now())`;
    expect(await bind(userId, code)).toEqual({ ok: true });
  });

  it("lets a promoter bind their own code", async () => {
    const code = freshCode();
    const self = await promoter(code);
    expect(await bind(self, code)).toEqual({ ok: true });
  });

  it("waits for a first payment being recorded on the same account and then refuses as already_paid", async () => {
    const code = freshCode();
    await promoter(code);
    const userId = await account();
    const subscriptionId = `sub_ref_${randomUUID()}`;
    await sql`insert into subscriptions(user_id,stripe_subscription_id,tier,period,status,current_period_end)
      values(${userId},${subscriptionId},'pro','month','active',now() + interval '30 days')`;

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const payment = sql.begin(async (tx) => {
      await tx`select id from users where id = ${userId} for update`;
      await tx`update subscriptions set first_active_at = now() where stripe_subscription_id = ${subscriptionId}`;
      await gate;
    });
    const binding = bind(userId, code);
    await waitUntilBlockedOn(sql, ["users", "for update"], 1);
    release();
    await payment;
    expect(await binding).toEqual({ ok: false, reason: "already_paid" });
    expect(await bindingOf(userId)).toBeNull();
  });

  // The four facts the rule reads, in every mix (inner#1868 §5): the first one
  // that fails names the refusal, and only a bind that succeeds writes a row.
  it("refuses for the first failed fact in the order code, binding, enterprise, payment, and binds otherwise", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("active", "disabled", "removed", "missing"),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        async (codeState, bound, enterprise, paid) => {
          const code = freshCode();
          if (codeState !== "missing") await promoter(code, codeState);
          const userId = await account();
          const earlier = freshCode();
          if (bound) {
            await promoter(earlier);
            expect(await bind(userId, earlier)).toEqual({ ok: true });
          }
          if (enterprise) {
            await sql`update users set membership_tier = 'enterprise' where id = ${userId}`;
            await sql`insert into enterprise_memberships(user_id,expires_at,entry_timezone,contract_number,team_studios,projects_per_studio,concurrent_editors,studio_members,project_members,storage_bytes,fallback_tier,revision)
              values(${userId},${new Date(Date.now() + 86_400_000)},'UTC',${`TEST-PROP-${randomUUID().slice(0, 8)}`},8,20,30,200,80,1099511627776,'base',1)`;
          }
          if (paid) {
            await sql`insert into subscriptions(user_id,stripe_subscription_id,tier,period,status,current_period_end,first_active_at)
              values(${userId},${`sub_prop_${randomUUID()}`},'pro','month','canceled',now(),now() - interval '40 days')`;
          }

          const expected = codeState !== "active" ? { ok: false, reason: "invalid_code" }
            : bound ? { ok: false, reason: "already_bound" }
              : enterprise ? { ok: false, reason: "not_eligible" }
                : paid ? { ok: false, reason: "already_paid" }
                  : { ok: true };
          expect(await bind(userId, code)).toEqual(expected);
          const row = await bindingOf(userId);
          if (bound) expect(row?.code).toBe(earlier);
          else if (expected.ok) expect(row?.code).toBe(code);
          else expect(row).toBeNull();
        },
      ),
      { numRuns: 64 },
    );
  });
});
