// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Operations beyond the monthly allowance, against real Postgres with
 * payments on (inner#1968, test spec area D: D-01 to D-04, D-06 to D-12,
 * D-20, and the 5.1 #7 resolution).
 *
 * An admission is `covered` while the in-flight covered operations leave room
 * in what remains of the allowance, otherwise it holds `overage_credits`
 * (0.5) on the studio under `operation:<key>` and is `held`. Counting decides
 * the slot from what is counted at that moment: `allowance` releases any
 * hold, `overage` records one `operation_overage` charge request of 0.5 that
 * takes the hold over. The 0.5 is a fixed credit price and is not scaled by
 * `CREDIT_MULTIPLIER`.
 *
 * The account is a pro admin whose live subscription is anchored a minute ago,
 * so the current period starts at that anchor; "U counted" rows are written
 * with that `period_start`. Nothing sleeps.
 *
 * Placement: the spec puts these at domain integration (D-11 at worker
 * integration, D-12 at integration-tests). Domain and worker have no
 * integration harness; D-11 drives the two credit-engine calls the sweep job
 * is made of, and D-12 is the domain half of the run that the cross-service
 * case drives end to end.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import postgres from "postgres";
import { db, getNodeTaskConfig, initCore, loadLocales, REPORT_GRACE_MS } from "@breatic/core";
import { creditHoldService, creditLotService, operationService } from "@breatic/domain";
import { seedDesignatedLot } from "./studio-credit-fixtures.js";

let sql: ReturnType<typeof postgres>;
const ALLOWANCE = 4000;
/** `operations.chat_message_lease_ms` in config/membership.yaml. */
const CHAT_LEASE_MS = 7_200_000;
const SUITE_ENV = {
  ...process.env,
  PAYMENT_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
  STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
};

beforeAll(() => {
  initCore(SUITE_ENV);
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false, connection: { application_name: "operation-overage-test" } });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  initCore(process.env);
});

interface Account {
  userId: string;
  studioId: string;
  projectId: string;
  /** The current period's start. */
  periodStart: Date;
}

type Kind = "generation" | "tool_run" | "upload" | "url_paste" | "chat_message" | "text_tool" | "timeline";

/**
 * The database clock, to millisecond precision.
 * @returns The current statement time.
 */
async function dbNow(): Promise<Date> {
  const [row] = await sql<{ now: Date }[]>`select date_trunc('milliseconds', statement_timestamp()) as now`;
  return row!.now;
}

/**
 * A pro account whose live subscription anchors the current period a minute
 * ago, administering a team studio with a project, with `used` operations
 * already counted this period and `credits` spendable in the studio.
 * @param used - Allowance rows counted this period.
 * @param credits - The studio's spendable balance; 0 seeds no purchase.
 * @returns The ids and the period start.
 */
async function account(used: number, credits: number): Promise<Account> {
  const now = await dbNow();
  const periodStart = new Date(now.getTime() - 60_000);
  const userId = randomUUID();
  const studioId = randomUUID();
  const projectId = randomUUID();
  await sql`insert into users(id, email, email_verified, membership_tier, created_at) values (${userId}, ${`${userId}@example.test`}, true, 'pro', ${new Date(now.getTime() - 200 * 86_400_000)})`;
  await sql`insert into studios(id, created_by_user_id, slug, type, name) values (${studioId}, ${userId}, ${`ov-${studioId}`}, 'team', 'Overage')`;
  await sql`insert into studio_members(studio_id, user_id, role) values (${studioId}, ${userId}, 'admin')`;
  await sql`insert into projects(id, studio_id, created_by_user_id, slug, name) values (${projectId}, ${studioId}, ${userId}, ${`ov-${projectId}`}, 'Overage')`;
  await sql`insert into subscriptions(user_id, stripe_subscription_id, tier, period, status, current_period_end, cancel_at_period_end, billing_cycle_anchor)
    values (${userId}, ${`sub_${randomUUID()}`}, 'pro', 'month', 'active', ${new Date(now.getTime() + 30 * 86_400_000)}, false, ${periodStart})`;
  const a = { userId, studioId, projectId, periodStart };
  if (used > 0) await counted(a, used);
  if (credits > 0) await fund(a, credits);
  return a;
}

/**
 * Give the studio exactly `credits` spendable: a one-credit purchase per whole
 * credit, rounded up, with its remainder set to the amount.
 * @param a - The account and its studio.
 * @param credits - The balance.
 */
async function fund(a: Account, credits: number): Promise<void> {
  const lot = await seedDesignatedLot(sql, a, Math.max(1, Math.ceil(credits)));
  await sql`update credit_lots set remaining_credits = ${credits} where id = ${lot}`;
}

/**
 * Allowance rows counted this period.
 * @param a - The account.
 * @param n - How many.
 */
async function counted(a: Account, n: number): Promise<void> {
  await sql`insert into operation_ledger(operation_key, kind, account_user_id, studio_id, project_id, actor_user_id, status, admitted_as, slot, period_start, counted_at, expires_at, created_at)
    select 'task:' || gen_random_uuid(), 'generation', ${a.userId}, ${a.studioId}, ${a.projectId}, ${a.userId}, 'counted', 'covered', 'allowance', ${a.periodStart}, ${a.periodStart}, ${a.periodStart}::timestamptz + interval '2 hours', ${a.periodStart}
    from generate_series(1, ${n})`;
}

/**
 * Admit one operation in the account's project.
 * @param a - The account.
 * @param kind - The operation kind.
 * @param key - Its operation key; a fresh task key by default.
 * @returns The key.
 */
async function admit(a: Account, kind: Kind = "generation", key = `task:${randomUUID()}`): Promise<string> {
  await operationService.admitOperation({ kind, key, projectId: a.projectId, actorUserId: a.userId, inputs: [] });
  return key;
}

/**
 * Count one admitted operation in its own success transaction.
 * @param key - The operation key.
 */
async function count(key: string): Promise<void> {
  await db.transaction((tx) => operationService.countOperation(key, tx));
}

interface LedgerRow {
  status: string;
  admitted_as: string;
  slot: string | null;
  overage_hold: string | null;
  charge_request_id: string | null;
  expires_at: Date;
  created_at: Date;
}

/**
 * One ledger row by key.
 * @param key - The operation key.
 * @returns The row, or undefined.
 */
async function ledger(key: string): Promise<LedgerRow | undefined> {
  const [row] = await sql<LedgerRow[]>`
    select status, admitted_as, slot, overage_hold, charge_request_id, expires_at, created_at from operation_ledger where operation_key = ${key}`;
  return row;
}

interface HoldRow {
  reference_id: string;
  amount: string;
  studio_id: string;
  actor_user_id: string;
  status: string;
  expires_at: Date;
}

/**
 * The credit hold filed under one reference.
 * @param referenceId - Its reference.
 * @returns The hold, or undefined.
 */
async function hold(referenceId: string): Promise<HoldRow | undefined> {
  const [row] = await sql<HoldRow[]>`
    select reference_id, amount::text, studio_id, actor_user_id, status, expires_at from credit_holds where reference_id = ${referenceId}`;
  return row;
}

interface RequestRow {
  id: string;
  kind: string;
  reference_id: string;
  actor_user_id: string;
  project_id: string | null;
  studio_id: string | null;
  amount: string;
  description: string | null;
  release_hold: string | null;
  status: string;
}

/**
 * The charge requests filed under one reference.
 * @param referenceId - Their reference.
 * @returns Every one, oldest first.
 */
async function requests(referenceId: string): Promise<RequestRow[]> {
  return sql<RequestRow[]>`
    select id, kind, reference_id, actor_user_id, project_id, studio_id, amount::text, description, release_hold, status
    from credit_charge_requests where reference_id = ${referenceId} order by created_at`;
}

/**
 * What the studio can spend, below zero when it owes.
 * @param a - The account and its studio.
 * @returns The spendable balance.
 */
async function balance(a: Account): Promise<number> {
  return Number((await creditHoldService.getCreditPosition(a.studioId)).spendable);
}

describe("admission at and beyond the allowance", () => {
  it("D-01 with 3999 counted and nothing in flight the next operation is covered with no credits, and counts into the allowance", async () => {
    const a = await account(ALLOWANCE - 1, 0);
    const key = await admit(a);
    expect((await ledger(key))?.admitted_as).toBe("covered");
    expect(await hold(`operation:${key}`)).toBeUndefined();
    await count(key);
    expect(await ledger(key)).toMatchObject({ status: "counted", slot: "allowance" });
    expect((await operationService.readOperationUsage(a.userId)).allowanceUsed).toBe(ALLOWANCE);
    expect(await requests(key)).toEqual([]);
  });

  it("D-02 with 4000 counted and 0.7 available the admission holds 0.5 under operation:<key> until the row expires", async () => {
    const a = await account(ALLOWANCE, 0.7);
    const key = await admit(a);
    const row = await ledger(key);
    expect(row).toMatchObject({ status: "reserved", admitted_as: "held", overage_hold: `operation:${key}` });
    const held = await hold(`operation:${key}`);
    expect(held).toMatchObject({ reference_id: `operation:${key}`, amount: "0.500000", studio_id: a.studioId, actor_user_id: a.userId, status: "held" });
    expect(held!.expires_at.toISOString()).toBe(row!.expires_at.toISOString());
  });

  it("D-03 the held operation succeeds: one 0.5 operation_overage request takes the hold over, and settling leaves 0.2", async () => {
    const a = await account(ALLOWANCE, 0.7);
    const key = await admit(a);
    await count(key);
    const row = await ledger(key);
    expect(row).toMatchObject({ status: "counted", slot: "overage" });
    const filed = await requests(key);
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({
      kind: "operation_overage",
      reference_id: key,
      actor_user_id: a.userId,
      project_id: a.projectId,
      studio_id: a.studioId,
      amount: "0.500000",
      description: "Operation overage",
      release_hold: `operation:${key}`,
      status: "pending",
    });
    expect(row!.charge_request_id).toBe(filed[0]!.id);

    await creditLotService.settleCharge(filed[0]!.id);
    expect((await requests(key))[0]?.status).toBe("settled");
    expect((await hold(`operation:${key}`))?.status).toBe("released");
    expect(await balance(a)).toBeCloseTo(0.2, 6);
    const spent = await sql<{ entry_type: string; amount: string; studio_id: string }[]>`
      select entry_type, amount::text, studio_id from credit_ledger where reference_id = ${key}`;
    expect(spent).toHaveLength(1);
    expect(spent[0]).toMatchObject({ entry_type: "spend", studio_id: a.studioId });
    expect(Math.abs(Number(spent[0]!.amount))).toBeCloseTo(0.5, 6);
  });

  it("D-04 exactly 0.5 available is enough to hold", async () => {
    const a = await account(ALLOWANCE, 0.5);
    const key = await admit(a);
    expect((await ledger(key))?.admitted_as).toBe("held");
    expect((await hold(`operation:${key}`))?.status).toBe("held");
  });

  it("D-06 with 3999 counted and one covered operation in flight the next one is held, not covered", async () => {
    const a = await account(ALLOWANCE - 1, 0.7);
    const inFlight = await admit(a);
    expect((await ledger(inFlight))?.admitted_as).toBe("covered");
    const next = await admit(a);
    expect((await ledger(next))?.admitted_as).toBe("held");
  });

  it("D-07 the in-flight one fails and the held one succeeds: it lands in the allowance, its hold is released and nothing is charged", async () => {
    const a = await account(ALLOWANCE - 1, 0.7);
    const inFlight = await admit(a);
    const next = await admit(a);
    await db.transaction((tx) => operationService.releaseOperation(inFlight, tx));
    expect((await ledger(inFlight))?.status).toBe("released");
    await count(next);
    expect(await ledger(next)).toMatchObject({ status: "counted", slot: "allowance", charge_request_id: null });
    expect((await hold(`operation:${next}`))?.status).toBe("released");
    expect(await requests(next)).toEqual([]);
    expect(await balance(a)).toBeCloseTo(0.7, 6);
  });

  it("D-08 a covered operation whose row expired succeeds after the allowance filled: it is charged 0.5 with no hold to release, into debt", async () => {
    const a = await account(ALLOWANCE - 1, 0);
    const late = await admit(a);
    await sql`update operation_ledger set expires_at = now() - interval '1 minute' where operation_key = ${late}`;
    const onTime = await admit(a);
    expect((await ledger(onTime))?.admitted_as).toBe("covered");
    await count(onTime);
    expect((await ledger(onTime))?.slot).toBe("allowance");

    await count(late);
    expect(await ledger(late)).toMatchObject({ status: "counted", slot: "overage" });
    const filed = await requests(late);
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ kind: "operation_overage", amount: "0.500000", release_hold: null });
    await creditLotService.settleCharge(filed[0]!.id);
    expect(await balance(a)).toBeCloseTo(-0.5, 6);
  });

  it("D-10 a studio avatar upload over the allowance is charged to the studio named on the request, with no project", async () => {
    const a = await account(ALLOWANCE, 3);
    const key = `upload:${a.userId}:${randomUUID()}`;
    await operationService.admitOperation({ kind: "upload", key, studioId: a.studioId, actorUserId: a.userId, inputs: [] });
    expect((await ledger(key))?.admitted_as).toBe("held");
    await count(key);
    const filed = await requests(key);
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ kind: "operation_overage", project_id: null, studio_id: a.studioId, amount: "0.500000" });
    await creditLotService.settleCharge(filed[0]!.id);
    expect(await balance(a)).toBeCloseTo(2.5, 6);
    const spent = await sql<{ entry_type: string; studio_id: string | null }[]>`
      select entry_type, studio_id from credit_ledger where reference_id = ${key}`;
    expect(spent).toEqual([{ entry_type: "spend", studio_id: a.studioId }]);
  });

  it("D-11 a settlement that did not happen after the count is taken by the sweep, and charges once", async () => {
    const a = await account(ALLOWANCE, 3);
    const key = `upload:${a.userId}:${randomUUID()}`;
    await operationService.admitOperation({ kind: "upload", key, studioId: a.studioId, actorUserId: a.userId, inputs: [] });
    await count(key);
    const [filed] = await requests(key);
    expect(filed?.status).toBe("pending");
    // What one round of credit-charge-sweep does: list what is left pending and settle it.
    const sweepable = await creditLotService.listSweepableChargeRequests(0, 10_000);
    expect(sweepable.map((r) => r.id)).toContain(filed!.id);
    await creditLotService.settleCharge(filed!.id);
    expect(await creditLotService.settleCharge(filed!.id)).toBeNull();
    expect((await requests(key))[0]?.status).toBe("settled");
    expect(await balance(a)).toBeCloseTo(2.5, 6);
  });

  it("D-12 a covered run that finishes after the allowance filled, with nothing left, still completes as overage and leaves a debt of 0.5", async () => {
    const a = await account(ALLOWANCE - 1, 0);
    const running = await admit(a);
    expect((await ledger(running))?.admitted_as).toBe("covered");
    await counted(a, 1);
    await count(running);
    expect(await ledger(running)).toMatchObject({ status: "counted", slot: "overage" });
    const [filed] = await requests(running);
    expect(filed).toMatchObject({ kind: "operation_overage", amount: "0.500000" });
    await creditLotService.settleCharge(filed!.id);
    expect(await balance(a)).toBeCloseTo(-0.5, 6);
  });
});

describe("D-09 the overage price is not scaled by CREDIT_MULTIPLIER", () => {
  beforeAll(() => {
    initCore({ ...SUITE_ENV, CREDIT_MULTIPLIER: "2" });
  });

  afterAll(() => {
    initCore(SUITE_ENV);
  });

  it("an Agent message over the allowance is charged 0.5 beside its own model fee, and the two requests do not collide", async () => {
    const a = await account(ALLOWANCE, 10);
    const key = await admit(a, "chat_message", `chat:${a.userId}:${randomUUID()}`);
    await count(key);
    const [overage] = await requests(key);
    expect(overage).toMatchObject({ kind: "operation_overage", amount: "0.500000" });
    // The same message's model fee, under the same reference.
    const fee = await db.transaction((tx) =>
      creditLotService.requestCharge({ kind: "operation", referenceId: key, actorUserId: a.userId, projectId: a.projectId, amount: 0.6 }, tx),
    );
    expect(fee).not.toBeNull();
    expect((await requests(key)).map((r) => r.kind).sort()).toEqual(["operation", "operation_overage"]);
    await creditLotService.settleCharge(overage!.id);
    expect(await balance(a)).toBeCloseTo(9.5, 6);
  });
});

describe("how long an admitted operation stays in flight", () => {
  it("5.1 #7 a generation row lives for the task budget plus REPORT_GRACE_MS, which is twice the container poll interval", async () => {
    expect(REPORT_GRACE_MS).toBe(10_000);
    const a = await account(0, 0);
    const key = await admit(a);
    const row = await ledger(key);
    const lifetime = row!.expires_at.getTime() - row!.created_at.getTime();
    expect(Math.abs(lifetime - (getNodeTaskConfig().default_budget_ms + REPORT_GRACE_MS))).toBeLessThan(1000);
  });

  it("D-20 an Agent message's row and its hold live for the chat lease, and once it lapses the message no longer counts as in flight", async () => {
    const a = await account(ALLOWANCE - 1, 0.7);
    const message = await admit(a, "chat_message", `chat:${a.userId}:${randomUUID()}`);
    const row = await ledger(message);
    expect(row?.admitted_as).toBe("covered");
    expect(Math.abs(row!.expires_at.getTime() - row!.created_at.getTime() - CHAT_LEASE_MS)).toBeLessThan(1000);

    // Nobody came back for it: the lease ran out.
    await sql`update operation_ledger set expires_at = now() - interval '1 second' where operation_key = ${message}`;
    const next = await admit(a);
    expect((await ledger(next))?.admitted_as).toBe("covered");

    // A held message's hold ends when its lease does.
    const full = await account(ALLOWANCE, 0.7);
    const heldMessage = await admit(full, "chat_message", `chat:${full.userId}:${randomUUID()}`);
    const heldRow = await ledger(heldMessage);
    expect(heldRow?.admitted_as).toBe("held");
    expect((await hold(`operation:${heldMessage}`))?.expires_at.toISOString()).toBe(heldRow!.expires_at.toISOString());
    expect(Math.abs(heldRow!.expires_at.getTime() - heldRow!.created_at.getTime() - CHAT_LEASE_MS)).toBeLessThan(1000);
  });
});
