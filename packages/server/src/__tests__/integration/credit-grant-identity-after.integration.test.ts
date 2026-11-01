// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import postgres from "postgres";
import { describe, expect, inject, it } from "vitest";
import { call, useInternalApp } from "./internal-api-harness.js";
import { waitUntilBlockedOn } from "./lock-probe.js";
import { GRANT_ADMIN, applied, fundingState, grantKey, operationPath, postGrant, profilePath, seedDebt, seedPersonal } from "./operator-credit-grant-fixtures.js";

const suite = useInternalApp("credit-grant-identity-after");

/**
 * Hold the debt row so an accepted grant retains its earlier identity locks.
 * @throws {Error} If PostgreSQL cannot acquire or release the test gate.
 */
async function holdDebt(studioId: string): Promise<() => Promise<void>> {
  const connection = postgres(inject("DATABASE_URL"), { max: 1, prepare: false });
  let acquired: () => void = () => {};
  let allowCommit: () => void = () => {};
  const taken = new Promise<void>((resolve) => { acquired = resolve; });
  const release = new Promise<void>((resolve) => { allowCommit = resolve; });
  const transaction = connection.begin(async (tx) => {
    await tx`select studio_id from studio_credit_debts where studio_id=${studioId} for update`;
    acquired();
    await release;
  });
  try {
    await Promise.race([taken, transaction.then(() => { throw new Error("Debt gate ended before acquiring its row"); })]);
  } catch (cause) {
    allowCommit();
    await transaction.finally(() => connection.end({ timeout: 1 }));
    throw cause;
  }
  return async (): Promise<void> => {
    allowCommit();
    try { await transaction; }
    finally { await connection.end({ timeout: 1 }); }
  };
}

describe("operator grant before a later identity change", () => {
  it.each(["account", "studio", "studio-type", "membership", "membership-deleted"])("P14 commits its original result before a later %s change", async (identity) => {
    const fx = await seedPersonal(suite.sql);
    expect((await call(suite.baseUrl, profilePath(fx.userId), { admin: GRANT_ADMIN })).status).toBe(200);
    await seedDebt(suite.sql, fx, "20.000000");
    const releaseDebt = await holdDebt(fx.studioId);
    const key = grantKey();
    const pending = postGrant(suite, fx, key);
    const mutation = postgres(inject("DATABASE_URL"), { max: 1, prepare: false });
    const table = identity === "account" ? "users" : identity.startsWith("studio") ? "studios" : "studio_members";
    let changing: Promise<unknown> | undefined;
    let released = false;
    try {
      await waitUntilBlockedOn(suite.sql, ["studio_credit_debts"]);
      changing = mutation.begin(async (tx) => {
        if (identity === "account") await tx`update users set deleted_at=now() where id=${fx.userId}`;
        else if (identity === "studio") await tx`update studios set deleted_at=now() where id=${fx.studioId}`;
        else if (identity === "studio-type") await tx`update studios set type='team' where id=${fx.studioId}`;
        else if (identity === "membership-deleted") await tx`update studio_members set deleted_at=now() where studio_id=${fx.studioId} and user_id=${fx.userId}`;
        else await tx`update studio_members set role='maintainer' where studio_id=${fx.studioId} and user_id=${fx.userId}`;
      });
      await waitUntilBlockedOn(suite.sql, ["update", table]);
      await releaseDebt();
      released = true;
      const result = applied(await pending);
      expect(result).toMatchObject({ operation: { key, accountId: fx.userId, adminId: GRANT_ADMIN }, personalStudioId: fx.studioId,
        grantedCredits: "100.000000", repaidCredits: "20.000000", remainingCredits: "80.000000", debtBefore: "20.000000", debtAfter: "0.000000" });
      await changing;
      const original = await call(suite.baseUrl, operationPath(key), { admin: GRANT_ADMIN });
      expect(original.status).toBe(200);
      expect(original.json).toEqual(result);
      expect(await fundingState(suite.sql, fx)).toMatchObject({ sources: 1, compensations: 1, lots: 1, operations: 1,
        topup: "100.000000", repaid: "20.000000", remaining: "80.000000", debt: "0.000000" });
    } finally {
      if (!released) await releaseDebt();
      await Promise.allSettled([pending, ...(changing ? [changing] : [])]);
      await mutation.end({ timeout: 1 });
    }
  });
});
