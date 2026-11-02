// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, initCore, initLogger, logger } from "@breatic/core";
import { creditLotService } from "@breatic/domain";
import { call, initInternalCore, useInternalApp } from "./internal-api-harness.js";
import { GRANT_ADMIN, OTHER_ADMIN, applied, expectGrantTables, expectStoredGrant, fundingState, grantBody, grantKey, grantPath, operationPath, postGrant, profilePath, seedDebt, seedPersonal } from "./operator-credit-grant-fixtures.js";
import type { GrantBody } from "./operator-credit-grant-fixtures.js";

const suite = useInternalApp("internal-api-credit-grants");
beforeEach(() => { initInternalCore(); });

describe("operator credit grants over signed HTTP", () => {
  it("P03 reads the account, its personal Studio and exact debt", async () => {
    const fx = await seedPersonal(suite.sql);
    await seedDebt(suite.sql, fx, "20.000000");
    const response = await call(suite.baseUrl, profilePath(fx.userId), { admin: GRANT_ADMIN });
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ account: { id: fx.userId, email: fx.email }, personalStudio: { id: fx.studioId, name: "Hold", slug: fx.studioSlug }, debtCredits: "20.000000", canGrant: true, reason: null });
  });

  it("P03 reports a missing profile account and an unavailable personal Studio", async () => {
    expect((await call(suite.baseUrl, profilePath(randomUUID()), { admin: GRANT_ADMIN })).status).toBe(404);
    const fx = await seedPersonal(suite.sql);
    await suite.sql`update studios set type='team' where id=${fx.studioId}`;
    const response = await call(suite.baseUrl, profilePath(fx.userId), { admin: GRANT_ADMIN });
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ account: { id: fx.userId, email: fx.email }, personalStudio: null, debtCredits: null, canGrant: false, reason: "personal_studio_unavailable" });
  });

  it.each(["compensation", "gift"] as const)("P04 posts a %s and reconciles its complete receipt", async (kind) => {
    const fx = await seedPersonal(suite.sql);
    await seedDebt(suite.sql, fx, "20.000000");
    const body = grantBody(fx, { kind });
    const key = grantKey();
    const result = applied(await postGrant(suite, fx, key, body));
    expect(result).toMatchObject({ sourceKind: kind, personalStudioId: fx.studioId, grantedCredits: "100.000000", repaidCredits: "20.000000", remainingCredits: "80.000000", debtBefore: "20.000000", debtAfter: "0.000000", operation: { key, adminId: GRANT_ADMIN } });
    await expectStoredGrant(suite.sql, fx, result, body);
    expect(await fundingState(suite.sql, fx)).toEqual({ sources: 1, compensations: kind === "compensation" ? 1 : 0, gifts: kind === "gift" ? 1 : 0, lots: 1, operations: 1, topup: "100.000000", repaid: "20.000000", remaining: "80.000000", debt: "0.000000" });
    const rows = await suite.sql<{ entry_type: string; amount: string; actor_user_id: string | null }[]>`
      select entry_type,amount::text,actor_user_id from credit_ledger where lot_id=${result.lotId} and entry_type='debt_repayment'`;
    expect(rows).toEqual([{ entry_type: "debt_repayment", amount: "-20.000000", actor_user_id: null }]);
    if (kind === "gift") {
      expect(await suite.sql`select origin from credit_gifts where id=${result.sourceId}`).toEqual([{ origin: "operator" }]);
    }
    expect(await suite.sql`select id from users where id=${GRANT_ADMIN}`).toEqual([]);
  });

  it.each([
    [null, "0.000000", "100.000000", "0.000000"],
    ["0.000000", "0.000000", "100.000000", "0.000000"],
    ["20.000000", "20.000000", "80.000000", "0.000000"],
    ["100.000000", "100.000000", "0.000000", "0.000000"],
    ["150.000000", "100.000000", "0.000000", "50.000000"],
  ])("P05 repays an original debt of %s exactly", async (debt, repaid, remaining, debtAfter) => {
    const fx = await seedPersonal(suite.sql);
    if (debt !== null) await seedDebt(suite.sql, fx, debt);
    const result = applied(await postGrant(suite, fx, grantKey()));
    expect(result).toMatchObject({ grantedCredits: "100.000000", debtBefore: debt ?? "0.000000", repaidCredits: repaid, remainingCredits: remaining, debtAfter });
    expect(await fundingState(suite.sql, fx)).toMatchObject({ topup: "100.000000", repaid, remaining, debt: debtAfter, sources: 1, lots: 1, operations: 1 });
  });

  it("P06 consumes one cent from an upper-bound grant without losing micro-credits", async () => {
    const fx = await seedPersonal(suite.sql);
    await seedDebt(suite.sql, fx, "20.000000");
    const result = applied(await postGrant(suite, fx, grantKey(), grantBody(fx, { credits: "99999999999999.99" })));
    expect(result.remainingCredits).toBe("99999999999979.990000");
    const charged = await creditLotService.chargeForGeneration({ projectId: fx.projectId, actorUserId: fx.userId, amount: 0.01, referenceId: randomUUID() });
    expect(charged).toMatchObject({ charged: "0.010000", shortfall: "0.000000" });
    expect(await fundingState(suite.sql, fx)).toMatchObject({ remaining: "99999999999979.980000", debt: "0.000000" });
    const [row] = await suite.sql<{ balance: string; ledger: string }[]>`
      select remaining_credits::text as balance,(select sum(amount)::numeric(20,6)::text from credit_ledger where lot_id=l.id) as ledger
      from credit_lots l where id=${result.lotId}`;
    expect(row).toEqual({ balance: "99999999999979.980000", ledger: "99999999999979.980000" });
  });

  it("P05 and M15 repay the exact upper-bound lot while retaining a fractional-cent debt", async () => {
    const fx = await seedPersonal(suite.sql);
    await seedDebt(suite.sql, fx, "99999999999999.999999");
    const result = applied(await postGrant(suite, fx, grantKey(), grantBody(fx, { credits: "99999999999999.99" })));
    expect(result).toMatchObject({ grantedCredits: "99999999999999.990000", repaidCredits: "99999999999999.990000",
      remainingCredits: "0.000000", debtBefore: "99999999999999.999999", debtAfter: "0.009999" });
    expect(await suite.sql`select amount::text from studio_credit_debts where studio_id=${fx.studioId}`).toEqual([{ amount: "0.009999" }]);
    expect(await suite.sql`select remaining_credits::text as remaining,lifecycle from credit_lots where id=${result.lotId}`)
      .toEqual([{ remaining: "0.000000", lifecycle: "depleted" }]);
    const rows = await suite.sql`select entry_type,amount::text from credit_ledger where lot_id=${result.lotId} order by entry_type`;
    expect(rows).toEqual([{ entry_type: "debt_repayment", amount: "-99999999999999.990000" }, { entry_type: "topup", amount: "99999999999999.990000" }]);
    await expectStoredGrant(suite.sql, fx, result, grantBody(fx, { credits: "99999999999999.99" }));
  });

  it("P07 serializes twenty identical original keys into one immutable decision", async () => {
    const fx = await seedPersonal(suite.sql);
    await seedDebt(suite.sql, fx, "20.000000");
    const key = grantKey();
    const responses = await Promise.all(Array.from({ length: 20 }, () => postGrant(suite, fx, key)));
    const original = applied(responses[0]!);
    for (const response of responses) expect(applied(response)).toEqual(original);
    const query = await call(suite.baseUrl, operationPath(key), { admin: GRANT_ADMIN });
    expect(query.status).toBe(200);
    expect(query.json).toEqual(original);
    expect(await fundingState(suite.sql, fx)).toMatchObject({ sources: 1, lots: 1, operations: 1, topup: "100.000000", repaid: "20.000000", remaining: "80.000000" });
  });

  it("P07 preserves idempotency for independently generated positive quantities", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 10000 }), async (cents) => {
      const fx = await seedPersonal(suite.sql);
      const credits = `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
      const key = grantKey();
      const body = grantBody(fx, { credits });
      const first = applied(await postGrant(suite, fx, key, body));
      expect(applied(await postGrant(suite, fx, key, body))).toEqual(first);
      expect(await fundingState(suite.sql, fx)).toMatchObject({ sources: 1, lots: 1, operations: 1, remaining: `${credits}0000` });
    }), { seed: 1411, numRuns: 5 });
  });

  it("P08 binds every original intent field, account and administrator to the key", async () => {
    const fx = await seedPersonal(suite.sql);
    const other = await seedPersonal(suite.sql);
    const key = grantKey();
    const original = applied(await postGrant(suite, fx, key));
    const changes: Partial<GrantBody>[] = [{ kind: "gift" }, { credits: "200.00" }, { reason: "Other reason" }, { expectedPersonalStudioId: other.studioId }];
    for (const change of changes) expect((await postGrant(suite, fx, key, grantBody(fx, change))).status).toBe(409);
    expect((await postGrant(suite, fx, key, grantBody(fx), { admin: OTHER_ADMIN })).status).toBe(409);
    expect((await postGrant(suite, other, key)).status).toBe(409);
    expect((await call(suite.baseUrl, operationPath(key), { admin: GRANT_ADMIN })).json).toEqual(original);
    expect(await fundingState(suite.sql, fx)).toMatchObject({ sources: 1, lots: 1, operations: 1, remaining: "100.000000" });
    expect(await fundingState(suite.sql, other)).toMatchObject({ sources: 0, lots: 0, operations: 0 });
  });

  it("P09 retains two legitimate grants as independent funding records", async () => {
    const fx = await seedPersonal(suite.sql);
    await seedDebt(suite.sql, fx, "20.000000");
    const first = applied(await postGrant(suite, fx, grantKey()));
    const second = applied(await postGrant(suite, fx, grantKey(), grantBody(fx, { kind: "gift", credits: "50.05" })));
    expect(first.sourceId).not.toBe(second.sourceId);
    expect(first.lotId).not.toBe(second.lotId);
    expect(await fundingState(suite.sql, fx)).toEqual({ sources: 2, compensations: 1, gifts: 1, lots: 2, operations: 2, topup: "150.050000", repaid: "20.000000", remaining: "130.050000", debt: "0.000000" });
    expect((await call(suite.baseUrl, operationPath(first.operation.key), { admin: GRANT_ADMIN })).json).toEqual(first);
    expect(first.remainingCredits).toBe("80.000000");
  });

  it("P10 refuses team and foreign personal snapshots without funding either", async () => {
    const fx = await seedPersonal(suite.sql);
    const foreign = await seedPersonal(suite.sql);
    const [team] = await suite.sql<{ id: string }[]>`insert into studios(created_by_user_id,slug,type,name) values(${fx.userId},${`t-${randomUUID()}`},'team','Team') returning id`;
    for (const studioId of [team!.id, foreign.studioId]) {
      const response = await postGrant(suite, fx, grantKey(), grantBody(fx, { expectedPersonalStudioId: studioId }));
      expect(response.status).toBe(200);
      expect(response.json).toMatchObject({ status: "refused", code: "personal_studio_changed" });
    }
    expect(await fundingState(suite.sql, fx)).toMatchObject({ sources: 0, lots: 0, operations: 2 });
    expect(await fundingState(suite.sql, foreign)).toMatchObject({ sources: 0, lots: 0, operations: 0 });
  });

  it("P10 persists account absence and personal-Studio unavailability as original refusals", async () => {
    const fx = await seedPersonal(suite.sql);
    const missingId = randomUUID();
    const missingKey = grantKey();
    const missing = await call(suite.baseUrl, grantPath(missingId), { admin: GRANT_ADMIN, body: grantBody(fx), idempotencyKey: missingKey });
    expect(missing.status).toBe(200);
    expect(missing.json).toMatchObject({ status: "refused", code: "account_not_found", operation: { accountId: missingId } });
    expect((await call(suite.baseUrl, operationPath(missingKey), { admin: GRANT_ADMIN })).json).toEqual(missing.json);
    await suite.sql`update studios set deleted_at=now() where id=${fx.studioId}`;
    const unavailable = await postGrant(suite, fx, grantKey());
    expect(unavailable.status).toBe(200);
    expect(unavailable.json).toMatchObject({ status: "refused", code: "personal_studio_unavailable" });
    expect(await fundingState(suite.sql, fx)).toMatchObject({ sources: 0, lots: 0, operations: 1 });
  });

  it("P10 refuses an old snapshot after the real personal Studio was replaced", async () => {
    const fx = await seedPersonal(suite.sql);
    await suite.sql`update studios set deleted_at=now() where id=${fx.studioId}`;
    const [replacement] = await suite.sql<{ id: string }[]>`insert into studios(created_by_user_id,slug,type,name)
      values(${fx.userId},${`p-${randomUUID()}`},'personal','Replacement') returning id`;
    await suite.sql`insert into studio_members(studio_id,user_id,role) values(${replacement!.id},${fx.userId},'admin')`;
    const response = await postGrant(suite, fx, grantKey());
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ status: "refused", code: "personal_studio_changed" });
    expect(await fundingState(suite.sql, fx)).toMatchObject({ sources: 0, lots: 0, operations: 1 });
  });

  it("P11 replays success and refusal before re-evaluating the payment switch", async () => {
    const fx = await seedPersonal(suite.sql);
    const successKey = grantKey();
    const success = applied(await postGrant(suite, fx, successKey));
    initCore({ ...process.env, PAYMENT_ENABLED: "false", INTERNAL_API_ENABLED: "true", INTERNAL_API_SECRET: "internal-secret-current-0123456789abcdef", INTERNAL_API_SECRET_PREVIOUS: "internal-secret-previous-0123456789abcdef" });
    try {
      expect((await postGrant(suite, fx, successKey)).json).toEqual(success);
      const refusedKey = grantKey();
      const refused = await postGrant(suite, fx, refusedKey);
      expect(refused.status).toBe(200);
      expect(refused.json).toMatchObject({ status: "refused", code: "payments_disabled" });
      const profile = await call(suite.baseUrl, profilePath(fx.userId), { admin: GRANT_ADMIN });
      expect(profile.status).toBe(200);
      expect(profile.json).toMatchObject({ canGrant: false, reason: "payments_disabled" });
      initInternalCore();
      expect((await postGrant(suite, fx, refusedKey)).json).toEqual(refused.json);
      expect(await fundingState(suite.sql, fx)).toMatchObject({ sources: 1, lots: 1, operations: 2 });
    } finally { initInternalCore(); }
  });

  it("P17 keeps the registration receipt and one-time claim separate from operator gifts", async () => {
    const fx = await seedPersonal(suite.sql);
    const trial = await db.transaction((tx) => creditLotService.grantTrialCredits({ userId: fx.userId, studioId: fx.studioId, credits: 50 }, tx));
    expect(trial?.sourceId).toBe(fx.userId);
    expect(await db.transaction((tx) => creditLotService.grantTrialCredits({ userId: fx.userId, studioId: fx.studioId, credits: 50 }, tx))).toBe(null);
    const rows = await suite.sql`select id,origin,operation_key,requested_by,reason from credit_gifts where id=${fx.userId}`;
    expect(rows).toEqual([{ id: fx.userId, origin: "registration", operation_key: null, requested_by: null, reason: null }]);
    const operator = applied(await postGrant(suite, fx, grantKey(), grantBody(fx, { kind: "gift" })));
    expect(operator.sourceId).not.toBe(fx.userId);
    expect(await suite.sql`select id from credit_lots where user_id=${fx.userId}`).toHaveLength(2);
  });

  it.each(["compensation", "gift"] as const)("P18 keeps %s pinned through effective designation and refund entries", async (kind) => {
    const fx = await seedPersonal(suite.sql);
    const other = await seedPersonal(suite.sql);
    const result = applied(await postGrant(suite, fx, grantKey(), grantBody(fx, { kind })));
    const [team] = await suite.sql<{ id: string }[]>`insert into studios(created_by_user_id,slug,type,name) values(${fx.userId},${`pt-${randomUUID()}`},'team','Team') returning id`;
    await suite.sql`insert into studio_members(studio_id,user_id,role) values(${team!.id},${fx.userId},'admin')`;
    for (const studioId of [fx.studioId, team!.id, other.studioId, null]) {
      await expect(creditLotService.designateLot({ lotId: result.lotId, requestingUserId: fx.userId, studioId })).rejects.toMatchObject({ statusCode: 403 });
    }
    await expect(creditLotService.requestRefund({ lotId: result.lotId, requestingUserId: fx.userId })).rejects.toMatchObject({ statusCode: 422 });
    expect(await fundingState(suite.sql, fx)).toMatchObject({ remaining: "100.000000" });
  });

  it.each(["profile", "write", "operation"])("P19 enforces signature authentication on the %s entry", async (entry) => {
    const fx = await seedPersonal(suite.sql);
    const path = entry === "profile" ? profilePath(fx.userId) : entry === "operation" ? operationPath(grantKey()) : grantPath(fx.userId);
    const data = entry === "write" ? { body: grantBody(fx), idempotencyKey: grantKey() } : {};
    for (const auth of [{ unsigned: true }, { secret: "incorrect-signature-key" }, { timestamp: Math.floor(Date.now() / 1000) - 3600 }]) {
      expect((await call(suite.baseUrl, path, { ...data, admin: GRANT_ADMIN, ...auth })).status).toBe(401);
    }
    const { createApp } = await import("@server/app.js");
    expect((await createApp().request(path)).status).toBe(404);
  });

  it("P19 rejects reused nonces and invalid grant request keys", async () => {
    const fx = await seedPersonal(suite.sql);
    const nonce = `grant-${randomUUID()}`;
    const first = await call(suite.baseUrl, profilePath(fx.userId), { admin: GRANT_ADMIN, nonce });
    expect(first.status).toBe(200);
    expect((await call(suite.baseUrl, profilePath(fx.userId), { admin: GRANT_ADMIN, nonce })).status).toBe(401);
    expect((await postGrant(suite, fx, "not-a-confirmation-key")).status).toBe(422);
    expect((await call(suite.baseUrl, grantPath(fx.userId), { admin: GRANT_ADMIN, body: grantBody(fx) })).status).toBe(422);
  });

  it.each([
    { credits: "0" }, { credits: "1e2" }, { credits: "0.001" }, { credits: "NaN" }, { credits: "Infinity" },
    { credits: 100 }, { reason: " " }, { reason: "x".repeat(501) }, { kind: "payment" },
    { expectedPersonalStudioId: "not-a-uuid" }, { studioId: "00000000-0000-4000-8000-000000000001" },
  ])("P19 rejects an invalid signed body without storing a decision %#", async (change) => {
    const fx = await seedPersonal(suite.sql);
    const response = await call(suite.baseUrl, grantPath(fx.userId), { admin: GRANT_ADMIN, idempotencyKey: grantKey(), body: { ...grantBody(fx), ...change } });
    expect(response.status).toBe(422);
    expect(await fundingState(suite.sql, fx)).toMatchObject({ sources: 0, lots: 0, operations: 0 });
  });

  it.each([
    ["GET", "/internal/v1/accounts/not-a-uuid/credit-grants/profile"],
    ["POST", "/internal/v1/accounts/not-a-uuid/credit-grants"],
    ["GET", "/internal/v1/credit-grant-operations/not-a-key"],
  ] as const)("P19 validates the signed %s path %s", async (method, path) => {
    const fx = await seedPersonal(suite.sql);
    const response = await call(suite.baseUrl, path, { method, admin: GRANT_ADMIN,
      ...(method === "POST" ? { body: grantBody(fx), idempotencyKey: grantKey() } : {}) });
    expect(response.status).toBe(422);
  });

  it("P20 restores an original decision after the caller discards its reply", async () => {
    const fx = await seedPersonal(suite.sql);
    const key = grantKey();
    expect((await call(suite.baseUrl, operationPath(key), { admin: GRANT_ADMIN })).status).toBe(404);
    const original = applied(await postGrant(suite, fx, key));
    const restored = await call(suite.baseUrl, operationPath(key), { admin: GRANT_ADMIN });
    expect(restored.status).toBe(200);
    expect(restored.json).toEqual(original);
    expect(applied(await postGrant(suite, fx, key))).toEqual(original);
    expect(await fundingState(suite.sql, fx)).toMatchObject({ sources: 1, lots: 1, operations: 1 });
  });

  it("P20 returns a finite read failure and logs its original cause with route context", async () => {
    await expectGrantTables(suite.sql);
    const fx = await seedPersonal(suite.sql);
    const key = grantKey();
    const original = applied(await postGrant(suite, fx, key));
    const logsRoot = mkdtempSync(join(tmpdir(), "credit-grant-read-failure-"));
    initLogger("credit-grant-read-failure", { logsRoot, debug: false, console: "none" });
    const error = vi.spyOn(logger, "error");
    await suite.sql`alter table credit_grant_operations rename to credit_grant_operations_read_failure`;
    try {
      const response = await call(suite.baseUrl, operationPath(key), { admin: GRANT_ADMIN });
      expect(response.status).toBe(500);
      expect(response.json).toEqual({ code: "internal_error" });
      expect(error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error), path: operationPath(key), method: "GET" }), "internal_api_error");
    } finally {
      await suite.sql`alter table credit_grant_operations_read_failure rename to credit_grant_operations`;
      error.mockRestore();
      rmSync(logsRoot, { recursive: true, force: true });
    }
    expect((await call(suite.baseUrl, operationPath(key), { admin: GRANT_ADMIN })).json).toEqual(original);
  });

});
