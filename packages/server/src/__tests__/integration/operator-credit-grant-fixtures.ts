// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { createHash, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { expect } from "vitest";
import { seedStudioFixture } from "./studio-credit-fixtures.js";
import type { StudioFixture } from "./studio-credit-fixtures.js";
import { call } from "./internal-api-harness.js";
import type { CallOptions, CallResult, InternalSuite } from "./internal-api-harness.js";

export type Sql = ReturnType<typeof postgres>;
export const GRANT_ADMIN = "00000000-0000-4000-8000-0000000000a1";
export const OTHER_ADMIN = "00000000-0000-4000-8000-0000000000b1";
export interface PersonalFixture extends StudioFixture { studioSlug: string; email: string }
export interface GrantBody { kind: "compensation" | "gift"; credits: string; reason: string; expectedPersonalStudioId: string }
export interface AppliedGrant {
  status: "applied";
  operation: { key: string; accountId: string; adminId: string; requestHash: string; recordedAt: string };
  sourceId: string; sourceKind: "compensation" | "gift"; lotId: string; personalStudioId: string;
  grantedCredits: string; repaidCredits: string; remainingCredits: string; debtBefore: string; debtAfter: string;
}

/** Create the ordinary account, membership and project fixture with a personal Studio. */
export async function seedPersonal(sql: Sql, label = "operator-grant"): Promise<PersonalFixture> {
  const fx = await seedStudioFixture(sql, label);
  const [studio] = await sql<{ slug: string }[]>`update studios set type='personal' where id=${fx.studioId} returning slug`;
  const [account] = await sql<{ email: string }[]>`select email from users where id=${fx.userId}`;
  await sql`insert into project_members(project_id,user_id,role) values(${fx.projectId},${fx.userId},'owner') on conflict do nothing`;
  return { ...fx, studioSlug: studio!.slug, email: account!.email };
}

/** The account's write endpoint. */
export function grantPath(userId: string): string { return `/internal/v1/accounts/${userId}/credit-grants`; }

/** The account's management profile endpoint. */
export function profilePath(userId: string): string { return `${grantPath(userId)}/profile`; }

/** The immutable original-result endpoint. */
export function operationPath(key: string): string { return `/internal/v1/credit-grant-operations/${key}`; }

/** An independent confirmation key in the agreed format. */
export function grantKey(): string { return `bo-${randomUUID()}`; }

/** The complete original body bound to the personal-Studio confirmation. */
export function grantBody(fx: PersonalFixture, changes: Partial<GrantBody> = {}): GrantBody {
  return { kind: "compensation", credits: "100.00", reason: "Service compensation", expectedPersonalStudioId: fx.studioId, ...changes };
}

/** Write the fixture's independently specified debt amount. */
export async function seedDebt(sql: Sql, fx: StudioFixture, amount: string): Promise<void> {
  await sql`insert into studio_credit_debts(studio_id,amount) values(${fx.studioId},${amount}::numeric)
    on conflict(studio_id) do update set amount=excluded.amount`;
  if (!/^0(?:\.0+)?$/.test(amount)) await sql`insert into credit_ledger(actor_user_id,studio_id,project_id,entry_type,amount,reference_id)
    values(${fx.userId},${fx.studioId},${fx.projectId},'debt_incurred',-${amount}::numeric,${randomUUID()})`;
}

/** Send a signed request with a fresh nonce while retaining its original key. */
export async function postGrant(suite: InternalSuite, fx: PersonalFixture, key: string, body = grantBody(fx), options: CallOptions = {}): Promise<CallResult> {
  return call(suite.baseUrl, grantPath(fx.userId), { body, idempotencyKey: key, admin: GRANT_ADMIN, ...options });
}

/** Assert the wire result before any query depends on its generated identifiers. */
export function applied(response: CallResult): AppliedGrant {
  expect(response.status).toBe(200);
  expect(response.json.status).toBe("applied");
  return response.json as AppliedGrant;
}

/** Independently construct the canonical original-intent fingerprint. */
export function expectedHash(userId: string, adminId: string, body: GrantBody): string {
  const canonical = JSON.stringify({ adminId, body: { credits: body.credits, expectedPersonalStudioId: body.expectedPersonalStudioId, kind: body.kind, reason: body.reason } });
  return createHash("sha256").update(["POST", "/internal/v1/accounts/:userId/credit-grants", userId, canonical].join("\n")).digest("hex");
}

/** Check that migration-owned tables exist through PostgreSQL catalog data. */
export async function expectGrantTables(sql: Sql): Promise<void> {
  const tables = ["credit_compensations", "credit_gifts", "credit_grant_operations"];
  for (const table of tables) {
    const [row] = await sql<{ relation: string | null }[]>`select to_regclass(${table})::text as relation`;
    expect(row!.relation, `${table} must be installed by the product migration`).toBe(table);
  }
}

/** Read the account's funding facts directly from the real database. */
export async function fundingState(sql: Sql, fx: StudioFixture): Promise<{
  sources: number; compensations: number; gifts: number; lots: number; operations: number;
  topup: string; repaid: string; remaining: string; debt: string;
}> {
  await expectGrantTables(sql);
  const [row] = await sql<{
    sources: number; compensations: number; gifts: number; lots: number; operations: number;
    topup: string; repaid: string; remaining: string; debt: string;
  }[]>`select
    (select count(*)::int from credit_sources s join credit_lots l on l.source_id=s.id where l.user_id=${fx.userId}) as sources,
    (select count(*)::int from credit_compensations where target_user_id=${fx.userId}) as compensations,
    (select count(*)::int from credit_gifts where target_user_id=${fx.userId} and origin='operator') as gifts,
    (select count(*)::int from credit_lots where user_id=${fx.userId}) as lots,
    (select count(*)::int from credit_grant_operations where target_user_id=${fx.userId}) as operations,
    (select coalesce(sum(amount),0)::numeric(20,6)::text from credit_ledger where payer_user_id=${fx.userId} and entry_type='topup') as topup,
    (select coalesce(-sum(amount),0)::numeric(20,6)::text from credit_ledger where payer_user_id=${fx.userId} and entry_type='debt_repayment') as repaid,
    (select coalesce(sum(remaining_credits),0)::numeric(20,6)::text from credit_lots where user_id=${fx.userId}) as remaining,
    (select coalesce((select amount from studio_credit_debts where studio_id=${fx.studioId}),0)::numeric(20,6)::text) as debt`;
  return row!;
}

/** Compare the immutable result with its source, receipt, lot and ledger. */
export async function expectStoredGrant(sql: Sql, fx: PersonalFixture, result: AppliedGrant, body: GrantBody): Promise<void> {
  expect(result.operation).toEqual({ key: result.operation.key, accountId: fx.userId, adminId: GRANT_ADMIN,
    requestHash: expectedHash(fx.userId, GRANT_ADMIN, body), recordedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/) });
  expect(result.personalStudioId).toBe(fx.studioId);
  expect(result.sourceKind).toBe(body.kind);
  const [lot] = await sql<{ source_id: string; source_kind: string; user_id: string; designated_studio_id: string; purchased: string; remaining: string }[]>`
    select source_id,source_kind,user_id,designated_studio_id,purchased_credits::text as purchased,remaining_credits::text as remaining
    from credit_lots where id=${result.lotId}`;
  expect(lot).toEqual({ source_id: result.sourceId, source_kind: body.kind, user_id: fx.userId, designated_studio_id: fx.studioId,
    purchased: result.grantedCredits, remaining: result.remainingCredits });
  const [sum] = await sql<{ ledger: string }[]>`select coalesce(sum(amount),0)::numeric(20,6)::text as ledger from credit_ledger where lot_id=${result.lotId}`;
  expect(sum!.ledger).toBe(result.remainingCredits);
  const table = body.kind === "gift" ? "credit_gifts" : "credit_compensations";
  const receipts = await sql<{ id: string; credits: string; reason: string; operation_key: string; requested_by: string }[]>`
    select id,credits::text,reason,operation_key,requested_by from ${sql(table)} where id=${result.sourceId}`;
  expect(receipts).toEqual([{ id: result.sourceId, credits: result.grantedCredits, reason: body.reason, operation_key: result.operation.key, requested_by: GRANT_ADMIN }]);
  const operations = await sql<{ result: unknown }[]>`select result from credit_grant_operations where key=${result.operation.key}`;
  expect(operations).toEqual([{ result }]);
}
