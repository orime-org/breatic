// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Self-hosted operations are not metered, against real Postgres (inner#1968,
 * test spec area E: E-01 to E-06 server half, E-09; D-13).
 *
 * Self-hosted is a deployment with payments off, or an account whose effective
 * tier is `self_hosted`. Admission then answers `not_metered` at once: no
 * ledger row, no `operation:` hold, no refusal; counting, deferring and the
 * expiry sweep find no row and do nothing; the account's membership answer
 * carries `operations: null`. Spend limits are not judged with payments off.
 *
 * The admission answers one of the outcomes design 3.3 names (`covered`,
 * `held`, `refused`, `taken`, `not_metered`) as `{ kind }`: `refused` carries
 * the studio's balance figures, so the answer is an object, discriminated the
 * way the upload path's `admitStorage` answer beside it is.
 *
 * Placement: the spec puts these at domain integration (E-04 at worker
 * integration, E-05 at server integration). Domain and worker have no
 * integration harness; E-04 calls the domain sweep the worker job runs.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import postgres from "postgres";
import { db, initCore, loadLocales } from "@breatic/core";
import { operationService } from "@breatic/domain";
import { readAccountMembership } from "@server/modules/account/membership.service.js";

let sql: ReturnType<typeof postgres>;
const PAYMENTS_ON = {
  ...process.env,
  PAYMENT_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
  STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
};
const PAYMENTS_OFF = { ...process.env, PAYMENT_ENABLED: "false" };

beforeAll(() => {
  initCore(PAYMENTS_OFF);
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false, connection: { application_name: "operation-self-hosted-test" } });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  initCore(process.env);
});

interface Account {
  userId: string;
  studioId: string;
  projectId: string;
}

type Kind = "generation" | "tool_run" | "upload" | "url_paste" | "chat_message" | "text_tool" | "timeline";

/**
 * An account administering a team studio with a project.
 * @param tier - Its stored tier.
 * @param registeredAt - Its `users.created_at`.
 * @returns The ids.
 */
async function account(tier: string, registeredAt: Date = new Date(Date.now() - 20 * 86_400_000)): Promise<Account> {
  const userId = randomUUID();
  const studioId = randomUUID();
  const projectId = randomUUID();
  await sql`insert into users(id, email, email_verified, membership_tier, created_at) values (${userId}, ${`${userId}@example.test`}, true, ${tier}, ${registeredAt})`;
  await sql`insert into studios(id, created_by_user_id, slug, type, name) values (${studioId}, ${userId}, ${`sh-${studioId}`}, 'team', 'Self-hosted')`;
  await sql`insert into studio_members(studio_id, user_id, role) values (${studioId}, ${userId}, 'admin')`;
  await sql`insert into projects(id, studio_id, created_by_user_id, slug, name) values (${projectId}, ${studioId}, ${userId}, ${`sh-${projectId}`}, 'Self-hosted')`;
  return { userId, studioId, projectId };
}

/**
 * Counted allowance rows in one period.
 * @param a - The account.
 * @param n - How many.
 * @param periodStart - Their period.
 */
async function counted(a: Account, n: number, periodStart: Date): Promise<void> {
  await sql`insert into operation_ledger(operation_key, kind, account_user_id, studio_id, project_id, actor_user_id, status, admitted_as, slot, period_start, counted_at, expires_at, created_at)
    select 'task:' || gen_random_uuid(), 'generation', ${a.userId}, ${a.studioId}, ${a.projectId}, ${a.userId}, 'counted', 'covered', 'allowance', ${periodStart}, ${periodStart}, ${periodStart}::timestamptz + interval '2 hours', ${periodStart}
    from generate_series(1, ${n})`;
}

/**
 * Admit one operation, then count it in a success transaction.
 * @param a - The account.
 * @param kind - Its kind.
 * @param key - Its key.
 * @returns The admission's answer.
 */
async function admitAndSucceed(a: Account, kind: Kind, key: string): Promise<unknown> {
  const answer = await operationService.admitOperation({ kind, key, projectId: a.projectId, actorUserId: a.userId, inputs: [] });
  await db.transaction((tx) => operationService.countOperation(key, tx));
  return answer;
}

/**
 * One successful operation of each metered kind, ten uploads among them.
 * @param a - The account.
 * @returns The outcome of every admission.
 */
async function everyKind(a: Account): Promise<unknown[]> {
  const outcomes: unknown[] = [];
  outcomes.push(await admitAndSucceed(a, "generation", `task:${randomUUID()}`));
  for (let i = 0; i < 10; i++) outcomes.push(await admitAndSucceed(a, "upload", `upload:${a.userId}:${randomUUID()}`));
  outcomes.push(await admitAndSucceed(a, "chat_message", `chat:${a.userId}:${randomUUID()}`));
  outcomes.push(await admitAndSucceed(a, "text_tool", `text_tool:${randomUUID()}`));
  outcomes.push(await admitAndSucceed(a, "timeline", `timeline:${randomUUID()}`));
  return outcomes;
}

/**
 * What the metering wrote for one account and its studio.
 * @param a - The account.
 * @returns Ledger rows, operation holds and overage requests.
 */
async function footprint(a: Account): Promise<{ ledger: number; holds: number; overage: number }> {
  const [ledger] = await sql<{ n: number }[]>`select count(*)::int as n from operation_ledger where account_user_id = ${a.userId}`;
  const [holds] = await sql<{ n: number }[]>`select count(*)::int as n from credit_holds where studio_id = ${a.studioId} and reference_id like 'operation:%'`;
  const [overage] = await sql<{ n: number }[]>`select count(*)::int as n from credit_charge_requests where actor_user_id = ${a.userId} and kind = 'operation_overage'`;
  return { ledger: ledger!.n, holds: holds!.n, overage: overage!.n };
}

describe("payments off", () => {
  it("E-01 a pro account's generation, ten uploads, Agent message, text tool and Timeline run write no ledger row, hold or overage request", async () => {
    const a = await account("pro");
    const outcomes = await everyKind(a);
    expect(outcomes).toEqual(outcomes.map(() => ({ kind: "not_metered" })));
    expect(await footprint(a)).toEqual({ ledger: 0, holds: 0, overage: 0 });
  });

  it("E-03 / D-13 with the allowance used up and no credits, a generation is not metered and is let through, and its success charges nothing", async () => {
    const a = await account("base");
    await counted(a, 4000, new Date(Date.now() - 20 * 86_400_000));
    const key = `task:${randomUUID()}`;
    expect(await admitAndSucceed(a, "generation", key)).toEqual({ kind: "not_metered" });
    expect(await sql`select 1 from operation_ledger where operation_key = ${key}`).toEqual([]);
    expect(await sql`select 1 from credit_charge_requests where reference_id = ${key}`).toEqual([]);
  });

  it("E-04 an upload leaves no deferred row, and the expiry sweep does nothing for the account", async () => {
    const a = await account("pro");
    const key = `upload:${a.userId}:${randomUUID()}`;
    expect(await operationService.admitOperation({ kind: "upload", key, projectId: a.projectId, actorUserId: a.userId, inputs: [] })).toEqual({ kind: "not_metered" });
    await operationService.sweepDeferredOperations();
    expect(await sql`select status from operation_ledger where account_user_id = ${a.userId}`).toEqual([]);
  });

  it("E-05 the account membership answer carries operations: null", async () => {
    const a = await account("pro");
    expect((await readAccountMembership(a.userId)).operations).toBeNull();
  });

  it("E-09 a per-member spend limit of 0 is not judged: the generation is let through", async () => {
    const a = await account("pro");
    await sql`insert into studio_spend_limits(studio_id, member_default_credits, studio_monthly_credits, updated_by_user_id) values (${a.studioId}, 0, null, ${a.userId})`;
    const key = `task:${randomUUID()}`;
    expect(await operationService.admitOperation({ kind: "generation", key, projectId: a.projectId, actorUserId: a.userId, inputs: [] })).toEqual({ kind: "not_metered" });
  });
});

describe("payments on, self_hosted tier", () => {
  beforeAll(() => {
    initCore(PAYMENTS_ON);
  });

  afterAll(() => {
    initCore(PAYMENTS_OFF);
  });

  it("E-02 a self_hosted account's operations write no ledger row, hold or overage request", async () => {
    const a = await account("self_hosted");
    const outcomes = await everyKind(a);
    expect(outcomes).toEqual(outcomes.map(() => ({ kind: "not_metered" })));
    expect(await footprint(a)).toEqual({ ledger: 0, holds: 0, overage: 0 });
    expect((await readAccountMembership(a.userId)).operations).toBeNull();
  });

  it("E-05 control: a pro account with payments on reads its operations", async () => {
    const a = await account("pro");
    expect((await readAccountMembership(a.userId)).operations).toMatchObject({ monthlyAllowance: 4000 });
  });

  it("E-06 an account moved from self_hosted to base carries on from the 30 counted in this base period", async () => {
    const registeredAt = new Date(Date.now() - 20 * 86_400_000);
    const a = await account("self_hosted", registeredAt);
    await counted(a, 30, registeredAt);
    await sql`update users set membership_tier = 'base' where id = ${a.userId}`;
    const key = `task:${randomUUID()}`;
    await operationService.admitOperation({ kind: "generation", key, projectId: a.projectId, actorUserId: a.userId, inputs: [] });
    const [row] = await sql<{ admitted_as: string }[]>`select admitted_as from operation_ledger where operation_key = ${key}`;
    expect(row?.admitted_as).toBe("covered");
    expect((await operationService.readOperationUsage(a.userId)).allowanceUsed).toBe(30);
  });
});
