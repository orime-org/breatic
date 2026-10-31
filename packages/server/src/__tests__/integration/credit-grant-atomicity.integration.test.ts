// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, inject, it } from "vitest";
import { creditLotService } from "@breatic/domain";
import { call, useInternalApp } from "./internal-api-harness.js";
import { waitUntilBlockedOn } from "./lock-probe.js";
import { seedDesignatedLot } from "./studio-credit-fixtures.js";
import { GRANT_ADMIN, applied, expectGrantTables, fundingState, grantKey, postGrant, profilePath, seedDebt, seedPersonal } from "./operator-credit-grant-fixtures.js";
import type { Sql } from "./operator-credit-grant-fixtures.js";

const suite = useInternalApp("credit-grant-atomicity");

/** Park the specified row on an independent connection until released. */
async function holdRow(table: "users" | "studios" | "studio_members" | "studio_credit_debts", column: "id" | "studio_id", id: string): Promise<() => Promise<void>> {
  const gate = postgres(inject("DATABASE_URL"), { max: 1, prepare: false, connection: { application_name: "credit-grant-lock-gate" } });
  let unlock: () => void = () => {};
  let acquired: () => void = () => {};
  const release = new Promise<void>((resolve) => { unlock = resolve; });
  const taken = new Promise<void>((resolve) => { acquired = resolve; });
  const transaction = gate.begin(async (tx) => {
    await tx`select * from ${tx(table)} where ${tx(column)}=${id} for update`;
    acquired();
    await release;
  });
  await Promise.race([taken, transaction.then(() => { throw new Error("Lock transaction ended before acquiring its row"); })]);
  return async (): Promise<void> => { unlock(); try { await transaction; } finally { await gate.end({ timeout: 1 }); } };
}

/** Install one transaction-local target failure in the real write path. */
async function failAt(sql: Sql, table: string, predicate: string, run: () => Promise<void>): Promise<void> {
  const name = `grant_fail_${randomUUID().replaceAll("-", "")}`;
  await sql.unsafe(`create function ${name}() returns trigger language plpgsql as $$ begin if ${predicate} then raise exception 'operator grant injected failure'; end if; return NEW; end $$`);
  try {
    await sql.unsafe(`create trigger ${name} before insert or update on ${table} for each row execute function ${name}()`);
    try { await run(); }
    finally { await sql.unsafe(`drop trigger ${name} on ${table}`); }
  } finally { await sql.unsafe(`drop function ${name}()`); }
}

describe("operator credit grant atomicity and observed locks", () => {
  it.each([
    ["credit_compensations", "NEW.target_user_id"],
    ["credit_gifts", "NEW.target_user_id"],
    ["credit_lots", "NEW.user_id"],
    ["credit_ledger_topup", "NEW.payer_user_id"],
    ["credit_ledger_repayment", "NEW.payer_user_id"],
    ["studio_credit_debts", "NEW.studio_id"],
    ["credit_grant_operations", "NEW.target_user_id"],
  ])("P12 rolls back every funding fact when %s fails", async (stage, field) => {
    await expectGrantTables(suite.sql);
    const fx = await seedPersonal(suite.sql);
    await seedDebt(suite.sql, fx, "20.000000");
    const before = await fundingState(suite.sql, fx);
    const sourcesBefore = await suite.sql`select count(*)::int as n from credit_sources`;
    const ledger = stage.startsWith("credit_ledger");
    const table = ledger ? "credit_ledger" : stage;
    const identity = stage === "studio_credit_debts" ? fx.studioId : fx.userId;
    const entry = ledger ? ` and NEW.entry_type='${stage.endsWith("topup") ? "topup" : "debt_repayment"}'` : stage === "studio_credit_debts" ? " and TG_OP='UPDATE'" : "";
    await failAt(suite.sql, table, `${field}::text='${identity}'${entry}`, async () => {
      const response = await postGrant(suite, fx, grantKey(), { kind: stage === "credit_gifts" ? "gift" : "compensation", credits: "100.00", reason: "Service compensation", expectedPersonalStudioId: fx.studioId });
      expect(response.status).toBe(500);
      expect(response.json).toEqual({ code: "internal_error" });
    });
    expect(await fundingState(suite.sql, fx)).toEqual(before);
    expect(await suite.sql`select count(*)::int as n from credit_sources`).toEqual(sourcesBefore);
    expect(await suite.sql`select id from credit_sources where id not in (select source_id from credit_lots)
      and id in (select id from credit_compensations where target_user_id=${fx.userId})`).toEqual([]);
  });

  it.each([
    ["users", "id", "userId"], ["studios", "id", "studioId"],
    ["studio_members", "studio_id", "studioId"], ["studio_credit_debts", "studio_id", "studioId"],
  ] as const)("P13 waits for the current %s row before granting", async (table, column, identity) => {
    const fx = await seedPersonal(suite.sql);
    expect((await call(suite.baseUrl, profilePath(fx.userId), { admin: GRANT_ADMIN })).status).toBe(200);
    await seedDebt(suite.sql, fx, "20.000000");
    const release = await holdRow(table, column, fx[identity]);
    const pending = postGrant(suite, fx, grantKey());
    try { await waitUntilBlockedOn(suite.sql, [table]); }
    finally { await release(); }
    const result = applied(await pending);
    expect(result).toMatchObject({ repaidCredits: "20.000000", remainingCredits: "80.000000", debtAfter: "0.000000" });
  });

  it("P13 permits the foreign-key key-share locks while grant identity locks are held", async () => {
    const fx = await seedPersonal(suite.sql);
    expect((await call(suite.baseUrl, profilePath(fx.userId), { admin: GRANT_ADMIN })).status).toBe(200);
    await seedDebt(suite.sql, fx, "20.000000");
    const release = await holdRow("studio_credit_debts", "studio_id", fx.studioId);
    const pending = postGrant(suite, fx, grantKey());
    const foreign = postgres(inject("DATABASE_URL"), { max: 1, prepare: false });
    try {
      await waitUntilBlockedOn(suite.sql, ["studio_credit_debts"]);
      await foreign.begin(async (tx) => {
        await tx`set local lock_timeout='3s'`;
        expect(await tx`select id from users where id=${fx.userId} for key share`).toEqual([{ id: fx.userId }]);
        expect(await tx`select id from studios where id=${fx.studioId} for key share`).toEqual([{ id: fx.studioId }]);
      });
    } finally { await foreign.end({ timeout: 1 }); await release(); }
    expect(applied(await pending).remainingCredits).toBe("80.000000");
  });

  it("P13 serializes an observed charge and grant on the shared debt row", async () => {
    const fx = await seedPersonal(suite.sql);
    expect((await call(suite.baseUrl, profilePath(fx.userId), { admin: GRANT_ADMIN })).status).toBe(200);
    await seedDesignatedLot(suite.sql, fx, 100);
    await seedDebt(suite.sql, fx, "20.000000");
    const release = await holdRow("studio_credit_debts", "studio_id", fx.studioId);
    const granting = postGrant(suite, fx, grantKey());
    const charging = creditLotService.chargeForGeneration({ projectId: fx.projectId, actorUserId: fx.userId, amount: 30, referenceId: randomUUID() });
    try { await waitUntilBlockedOn(suite.sql, ["studio_credit_debts"], 2); }
    finally { await release(); }
    expect(applied(await granting).repaidCredits).toBe("20.000000");
    expect(await charging).toMatchObject({ charged: "30.000000", shortfall: "0.000000" });
    expect(await fundingState(suite.sql, fx)).toMatchObject({ lots: 2, topup: "200.000000", remaining: "150.000000", repaid: "20.000000", debt: "0.000000" });
  });

  it.each(["account", "studio", "studio-type", "membership", "membership-deleted"])("P14 rechecks an identity changed under the %s lock", async (identity) => {
    const fx = await seedPersonal(suite.sql);
    expect((await call(suite.baseUrl, profilePath(fx.userId), { admin: GRANT_ADMIN })).status).toBe(200);
    await seedDebt(suite.sql, fx, "20.000000");
    const table = identity === "account" ? "users" : identity.startsWith("studio") ? "studios" : "studio_members";
    const gate = postgres(inject("DATABASE_URL"), { max: 1, prepare: false });
    let release: () => void = () => {};
    let acquired: () => void = () => {};
    const held = new Promise<void>((resolve) => { acquired = resolve; });
    const allowed = new Promise<void>((resolve) => { release = resolve; });
    const changing = gate.begin(async (tx) => {
      if (identity === "account") await tx`update users set deleted_at=now() where id=${fx.userId}`;
      else if (identity === "studio") await tx`update studios set deleted_at=now() where id=${fx.studioId}`;
      else if (identity === "studio-type") await tx`update studios set type='team' where id=${fx.studioId}`;
      else if (identity === "membership-deleted") await tx`update studio_members set deleted_at=now() where studio_id=${fx.studioId} and user_id=${fx.userId}`;
      else await tx`update studio_members set role='maintainer' where studio_id=${fx.studioId} and user_id=${fx.userId}`;
      acquired(); await allowed;
    });
    await held;
    const pending = postGrant(suite, fx, grantKey());
    try { await waitUntilBlockedOn(suite.sql, [table]); }
    finally { release(); await changing; await gate.end({ timeout: 1 }); }
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ status: "refused", code: identity === "account" ? "account_not_found" : "personal_studio_unavailable" });
    expect(await fundingState(suite.sql, fx)).toMatchObject({ sources: 0, lots: 0, operations: 1, debt: "20.000000" });
  });
});
