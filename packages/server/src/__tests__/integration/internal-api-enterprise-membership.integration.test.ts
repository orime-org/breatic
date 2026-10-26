// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { db, getMembershipConfig, getMembershipReadingForUser } from "@breatic/core";
import { tierLimitsSchema } from "@breatic/shared";
import type { SubscriptionWrite } from "@breatic/core";
import { applySubscriptionWrite } from "@server/modules/subscription/apply-subscription.js";
import { call, useInternalApp } from "./internal-api-harness.js";
import { waitUntilBlockedOn } from "./lock-probe.js";

const suite = useInternalApp("internal-api-enterprise-membership");
const limits = { team_studios: 8, projects_per_studio: 500, concurrent_editors: 30, studio_members: 200, project_members: 80, storage_bytes: 1099511627776 };
const body = { targetTier: "enterprise", expiresAt: "2099-10-26T00:00:00.000Z", entryTimezone: "UTC", contractNumber: "ENT-29", limits, expectedRevision: null, expectedStoredTier: "pro" };

/** Create one live account on the selected tier. */
async function user(tier = "pro"): Promise<string> {
  const [row] = await suite.sql<{ id: string }[]>`insert into users (email,membership_tier) values (${`${randomUUID()}@example.test`},${tier}) returning id`;
  return row!.id;
}

/** The membership endpoint for one account. */
function path(id: string): string { return `/internal/v1/accounts/${id}/enterprise-membership`; }

/** One correctly shaped request key. */
function key(): string { return `bo-${randomUUID()}`; }

/** Count operations carrying one immutable request key. */
async function operationCount(requestKey: string): Promise<number> {
  const [row] = await suite.sql<{ n: number }[]>`select count(*)::int n from enterprise_membership_operations where key=${requestKey}`;
  return row!.n;
}

/** One already-observed ordinary subscription fact for the shared write path. */
function subscriptionFact(userId: string, subscriptionId: string, status: "active" | "canceled", observedAt: Date): SubscriptionWrite {
  return { userId, stripeSubscriptionId: subscriptionId, tier: "pro", period: "month", status, currentPeriodEnd: new Date("2099-10-26T00:00:00.000Z"), cancelAtPeriodEnd: false, stripeItemId: "si_enterprise_fact", hasPendingUpdate: false, pendingTier: null, pendingPeriod: null, payableInvoiceUrl: null, observedAt };
}

describe("enterprise membership signed internal API", () => {
  it("requires a valid signature", async () => {
    const response = await call(suite.baseUrl, path(await user()), { body, idempotencyKey: key(), unsigned: true });
    expect(response.status).toBe(401);
    expect(response.json.code).toBe("unauthorized");
  });

  it("reports a missing account profile as not found", async () => {
    const response = await call(suite.baseUrl, path(randomUUID()));
    expect(response.status).toBe(404); expect(response.json.code).toBe("not_found");
  });

  it.each(["/internal/v1/accounts/not-a-uuid/enterprise-membership", "/internal/v1/enterprise-membership-operations/not-a-key"])("rejects an invalid path identity at %s", async (target) => {
    const response = await call(suite.baseUrl, target);
    expect(response.status).toBe(422); expect(response.json.code).toBe("invalid_body");
  });

  it.each(["GET", "POST"] as const)("retains RFC identity validation for a signed %s with a database-valid legacy identity", async (method) => {
    const id = `00000000-0000-0000-0000-${randomUUID().slice(-12)}`;
    const requestKey = key();
    await suite.sql`insert into users(id,email,membership_tier) values(${id},${`${id}@example.test`},'pro')`;
    const response = await call(suite.baseUrl, path(id), { method, ...(method === "POST" ? { body, idempotencyKey: requestKey } : {}) });
    expect(response.status).toBe(422);
    expect(response.json.code).toBe("invalid_body");
    expect(await operationCount(requestKey)).toBe(0);
    expect(await suite.sql`select user_id from enterprise_memberships where user_id=${id}`).toEqual([]);
    expect(await suite.sql`select membership_tier from users where id=${id}`).toEqual([{ membership_tier: "pro" }]);
    expect(await suite.sql`select id from membership_tier_changes where user_id=${id}`).toEqual([]);
  });

  it("retains management profile validation while ordinary reading ignores mailbox transport format", async () => {
    const id = await user();
    await suite.sql`update users set email=${`legacy-mailbox-${id}`} where id=${id}`;
    expect(await getMembershipReadingForUser(id)).toMatchObject({ storedTier: "pro", effectiveTier: "pro", enterpriseState: "ordinary", revision: null, expiresAt: null });
    const response = await call(suite.baseUrl, path(id));
    expect(response.status).toBe(500);
    expect(response.json).toEqual({ code: "internal_error" });
  });

  it.each([
    ["self_hosted", "self_hosted", "ordinary"],
    ["enterprise", "self_hosted", "expired"],
    ["enterprise", "base", "expired"],
  ] as const)("serves large configured limits for raw %s with effective %s in a signed %s profile", async (storedTier, effectiveTier, enterpriseState) => {
    const id = await user(effectiveTier);
    const config = getMembershipConfig();
    const original = config.tiers[effectiveTier];
    const configured = tierLimitsSchema.parse({ team_studios: 2147483648, projects_per_studio: 2147483648, concurrent_editors: 2147483648, studio_members: 2147483648, project_members: 2147483648, storage_bytes: Number.MAX_SAFE_INTEGER });
    if (storedTier === "enterprise") {
      const opened = await call(suite.baseUrl, path(id), { body: { ...body, expiresAt: "2000-01-01T00:00:00.000Z", expectedStoredTier: effectiveTier }, idempotencyKey: key() });
      expect(opened.status).toBe(200);
      expect(opened.json).toMatchObject({ status: "applied", after: { storedTier: "enterprise", enterprise: { fallbackTier: effectiveTier, revision: 1 } } });
    }
    config.tiers[effectiveTier] = configured;
    try {
      const response = await call(suite.baseUrl, path(id));
      expect(response.status).toBe(200);
      expect(response.json.account).toEqual({ id, email: expect.stringMatching(/@example\.test$/) });
      expect(response.json.snapshot).toMatchObject({ userId: id, storedTier });
      expect(response.json.reading).toEqual({
        asOf: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/), enterpriseState, effectiveTier, limits: configured,
        storageBytes: configured.storage_bytes, revision: storedTier === "enterprise" ? 1 : null,
        expiresAt: storedTier === "enterprise" ? "2000-01-01T00:00:00.000Z" : null,
        fallbackTier: storedTier === "enterprise" ? effectiveTier : null, settlementProtected: effectiveTier === "self_hosted",
      });
      expect(response.json.snapshot.enterprise).toEqual(storedTier === "enterprise" ? expect.objectContaining({ limits, revision: 1, fallbackTier: effectiveTier }) : null);
    } finally {
      config.tiers[effectiveTier] = original;
    }
  });

  it.each(["team_studios", "projects_per_studio", "concurrent_editors", "studio_members", "project_members"] as const)("rejects an oversized negotiated %s before any membership write", async (field) => {
    const id = await user();
    const requestKey = key();
    const response = await call(suite.baseUrl, path(id), { body: { ...body, limits: { ...limits, [field]: 2147483648 } }, idempotencyKey: requestKey });
    expect(response.status).toBe(422);
    expect(response.json.code).toBe("invalid_body");
    expect(await operationCount(requestKey)).toBe(0);
    expect(await suite.sql`select user_id from enterprise_memberships where user_id=${id}`).toEqual([]);
    expect(await suite.sql`select membership_tier from users where id=${id}`).toEqual([{ membership_tier: "pro" }]);
    expect(await suite.sql`select id from membership_tier_changes where user_id=${id}`).toEqual([]);
  });

  it.each([undefined, "not-a-key"])("rejects a missing or malformed write key %s", async (requestKey) => {
    const id = await user();
    const response = await call(suite.baseUrl, path(id), { body, idempotencyKey: requestKey });
    expect(response.status).toBe(422); expect(response.json.code).toBe("invalid_body");
    expect(await suite.sql`select user_id from enterprise_memberships where user_id=${id}`).toEqual([]);
  });

  it("atomically stores complete information, tier history and the original result", async () => {
    const id = await user(); const requestKey = key();
    const response = await call(suite.baseUrl, path(id), { body, idempotencyKey: requestKey });
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ status: "applied", operation: { key: requestKey, accountId: id, adminId: "admin_7" }, before: { userId: id, storedTier: "pro", enterprise: null }, after: { userId: id, storedTier: "enterprise", enterprise: { expiresAt: body.expiresAt, entryTimezone: body.entryTimezone, contractNumber: body.contractNumber, limits, revision: 1, fallbackTier: "base" } } });
    expect(response.json.after.enterprise.limits).toEqual(limits);
    const [stored] = await suite.sql<{ membership_tier: string }[]>`select membership_tier from users where id=${id}`;
    expect(stored!.membership_tier).toBe("enterprise");
    const history = await suite.sql`select from_tier,to_tier,reason,reference_id from membership_tier_changes where user_id=${id}`;
    expect(history).toEqual([{ from_tier: "pro", to_tier: "enterprise", reason: "manual", reference_id: requestKey }]);
    expect(await operationCount(requestKey)).toBe(1);
    const replay = await call(suite.baseUrl, `/internal/v1/enterprise-membership-operations/${requestKey}`);
    expect(replay.status).toBe(200); expect(replay.json).toEqual(response.json);
  });

  it("reads current entitlement separately from stored operation snapshots", async () => {
    const id = await user();
    await call(suite.baseUrl, path(id), { body, idempotencyKey: key() });
    const response = await call(suite.baseUrl, path(id));
    expect(response.status).toBe(200);
    expect(response.json.snapshot).toMatchObject({ userId: id, storedTier: "enterprise", enterprise: { limits, revision: 1 } });
    expect(response.json.reading).toMatchObject({ enterpriseState: "active", effectiveTier: "enterprise", limits, storageBytes: null, settlementProtected: true });
  });

  it.each([{ ...body, contractNumber: "" }, { ...body, extra: true }, { ...body, limits: { ...limits, team_studios: -1 } }, { ...body, entryTimezone: "No/Such_Zone" }])("rejects malformed bodies before claiming a key", async (invalid) => {
    const requestKey = key(); const id = await user();
    const response = await call(suite.baseUrl, path(id), { body: invalid, idempotencyKey: requestKey });
    expect(response.status).toBe(422); expect(response.json.code).toBe("invalid_body");
    expect(await operationCount(requestKey)).toBe(0);
  });

  it("replays the original operator and snapshot across owners without another write", async () => {
    const id = await user(); const requestKey = key();
    const first = await call(suite.baseUrl, path(id), { body, idempotencyKey: requestKey });
    const again = await call(suite.baseUrl, path(id), { body, idempotencyKey: requestKey, admin: "another_owner" });
    expect(first.status).toBe(200); expect(again.status).toBe(200); expect(again.json).toEqual(first.json);
    expect(await operationCount(requestKey)).toBe(1);
    const [count] = await suite.sql<{ n: number }[]>`select count(*)::int n from membership_tier_changes where user_id=${id}`;
    expect(count!.n).toBe(1);
  });

  it("preserves immutable replay and one-operation invariants across negotiated limits", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 2147483647 }), async (teamStudios) => {
      const id = await user(); const requestKey = key();
      const negotiated = { ...body, limits: { ...limits, team_studios: teamStudios } };
      const first = await call(suite.baseUrl, path(id), { body: negotiated, idempotencyKey: requestKey });
      const replay = await call(suite.baseUrl, path(id), { body: negotiated, idempotencyKey: requestKey });
      expect(first.status).toBe(200); expect(replay.status).toBe(200);
      expect(first.json.after.enterprise.limits.team_studios).toBe(teamStudios);
      expect(replay.json).toEqual(first.json); expect(await operationCount(requestKey)).toBe(1);
    }), { numRuns: 5 });
  });

  it("completes a legacy enterprise record while preserving its stored tier", async () => {
    const id = await user("enterprise");
    const response = await call(suite.baseUrl, path(id), { body: { ...body, expectedStoredTier: "enterprise" }, idempotencyKey: key() });
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ status: "applied", before: { storedTier: "enterprise", enterprise: null }, after: { storedTier: "enterprise", enterprise: { revision: 1, fallbackTier: "base" } } });
    expect(await suite.sql`select id from membership_tier_changes where user_id=${id}`).toEqual([]);
  });

  it("refuses a reused key with another body or account", async () => {
    const id = await user(); const other = await user(); const requestKey = key();
    expect((await call(suite.baseUrl, path(id), { body, idempotencyKey: requestKey })).status).toBe(200);
    for (const [target, changed] of [[id, { ...body, contractNumber: "OTHER" }], [other, body]] as const) {
      const response = await call(suite.baseUrl, path(target), { body: changed, idempotencyKey: requestKey });
      expect(response.status).toBe(409); expect(response.json.code).toBe("idempotency_conflict");
    }
    expect(await operationCount(requestKey)).toBe(1);
  });

  it("persists missing-account refusals and replays them after account changes", async () => {
    const id = randomUUID(); const requestKey = key();
    const response = await call(suite.baseUrl, path(id), { body, idempotencyKey: requestKey });
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ status: "refused", code: "account_not_found", before: null, after: null });
    expect(await operationCount(requestKey)).toBe(1);
    await suite.sql`insert into users (id,email,membership_tier) values (${id},${`${id}@example.test`},'pro')`;
    const again = await call(suite.baseUrl, path(id), { body, idempotencyKey: requestKey });
    expect(again.json).toEqual(response.json);
  });

  it("treats deleted accounts as missing and keeps refusal snapshots null", async () => {
    const id = await user(); await suite.sql`update users set deleted_at=now() where id=${id}`;
    const response = await call(suite.baseUrl, path(id), { body, idempotencyKey: key() });
    expect(response.status).toBe(200); expect(response.json).toMatchObject({ status: "refused", code: "account_not_found", before: null, after: null });
  });

  it("updates same-tier information with a new revision and no extra tier history", async () => {
    const id = await user();
    const first = await call(suite.baseUrl, path(id), { body, idempotencyKey: key() });
    expect(first.status).toBe(200);
    const update = { ...body, contractNumber: "ENT-29-REV2", limits: { ...limits, team_studios: 0 }, expectedStoredTier: "enterprise", expectedRevision: 1 };
    const second = await call(suite.baseUrl, path(id), { body: update, idempotencyKey: key() });
    expect(second.status).toBe(200); expect(second.json).toMatchObject({ status: "applied", before: first.json.after, after: { enterprise: { revision: 2, contractNumber: update.contractNumber, limits: update.limits } } });
    const [count] = await suite.sql<{ n: number }[]>`select count(*)::int n from membership_tier_changes where user_id=${id}`;
    expect(count!.n).toBe(1);
  });

  it("serializes competing revisions after the account row lock", async () => {
    const id = await user();
    const connection = await suite.sql.reserve();
    await connection`begin`; await connection`select id from users where id=${id} for update`;
    const first = call(suite.baseUrl, path(id), { body, idempotencyKey: key() });
    const second = call(suite.baseUrl, path(id), { body, idempotencyKey: key() });
    try { await waitUntilBlockedOn(suite.sql, ["users", "for update"], 2); }
    finally { await connection`commit`; connection.release(); }
    const results = await Promise.all([first, second]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results.map((r) => r.json.status).sort()).toEqual(["applied", "refused"]);
    const refused = results.find((r) => r.json.status === "refused")!.json;
    expect(refused.code).toBe("revision_conflict"); expect(refused.before).toEqual(refused.after);
    expect(refused.before.enterprise.revision).toBe(1);
  });

  it("retains self-hosted origin and recomputes origin when reopened from an ordinary tier", async () => {
    const id = await user("self_hosted");
    const first = await call(suite.baseUrl, path(id), { body: { ...body, expectedStoredTier: "self_hosted" }, idempotencyKey: key() });
    expect(first.status).toBe(200); expect(first.json.after.enterprise.fallbackTier).toBe("self_hosted");
    await suite.sql`update users set membership_tier='pro' where id=${id}`;
    const reopened = await call(suite.baseUrl, path(id), { body: { ...body, expectedRevision: 1 }, idempotencyKey: key() });
    expect(reopened.status).toBe(200); expect(reopened.json.after.enterprise.fallbackTier).toBe("base");
    expect(reopened.json.after.enterprise.revision).toBe(2);
    expect(reopened.json.before.enterprise.fallbackTier).toBe("self_hosted");
  });

  it("preserves expired self-hosted origin after ordinary activation and ending facts", async () => {
    const id = await user("self_hosted"); const subscriptionId = `sub_${randomUUID()}`;
    const opened = await call(suite.baseUrl, path(id), { body: { ...body, expiresAt: "2020-01-01T00:00:00.000Z", expectedStoredTier: "self_hosted" }, idempotencyKey: key() });
    expect(opened.status).toBe(200); expect(opened.json.status).toBe("applied");
    const observed = Date.now();
    for (const [index, status] of (["active", "canceled"] as const).entries()) {
      const settled = await db.transaction((tx) => applySubscriptionWrite({ userId: id, write: subscriptionFact(id, subscriptionId, status, new Date(observed + index)), referenceId: `enterprise-origin-${status}`, tx }));
      expect(settled.endedFrom).toBeNull();
      const profile = await call(suite.baseUrl, path(id));
      expect(profile.status).toBe(200);
      expect(profile.json.snapshot).toMatchObject({ storedTier: "enterprise", enterprise: { fallbackTier: "self_hosted", revision: 1 } });
      expect(profile.json.reading).toMatchObject({ enterpriseState: "expired", effectiveTier: "self_hosted", settlementProtected: true });
    }
    expect(await suite.sql`select id from notifications where user_id=${id} and type='membership.ended'`).toEqual([]);
    expect(await suite.sql`select to_tier from membership_tier_changes where user_id=${id}`).toEqual([{ to_tier: "enterprise" }]);
  });

  it.each(["active", "canceled"] as const)("normalizes expired SaaS enterprise from an ordinary %s fact with no enterprise-ending notice", async (status) => {
    const id = await user(); const subscriptionId = `sub_${randomUUID()}`;
    const opened = await call(suite.baseUrl, path(id), { body: { ...body, expiresAt: "2020-01-01T00:00:00.000Z" }, idempotencyKey: key() });
    expect(opened.status).toBe(200);
    const observed = Date.now();
    const result = await db.transaction((tx) => applySubscriptionWrite({ userId: id, write: subscriptionFact(id, subscriptionId, status, new Date(observed)), referenceId: "enterprise-normalize", tx }));
    expect(result.endedFrom).toBeNull();
    const profile = await call(suite.baseUrl, path(id));
    const tier = status === "active" ? "pro" : "base";
    expect(profile.json.snapshot).toMatchObject({ storedTier: tier, enterprise: { fallbackTier: "base", revision: 1 } });
    expect(profile.json.reading).toMatchObject({ enterpriseState: "ordinary", effectiveTier: tier, settlementProtected: false });
    expect(await suite.sql`select id from notifications where user_id=${id} and type='membership.ended'`).toEqual([]);
    if (status === "active") {
      const ending = await db.transaction((tx) => applySubscriptionWrite({ userId: id, write: subscriptionFact(id, subscriptionId, "canceled", new Date(observed + 1)), referenceId: "ordinary-ending", tx }));
      expect(ending.endedFrom).toBe("pro");
      const notices = await suite.sql<{ payload: unknown }[]>`select payload from notifications where user_id=${id} and type='membership.ended'`;
      expect(notices).toEqual([{ payload: { fromTier: "pro" } }]);
    }
  });

  it("serializes the same key and returns exactly the same committed result", async () => {
    const id = await user(); const requestKey = key();
    const connection = await suite.sql.reserve();
    await connection`begin`; await connection`select id from users where id=${id} for update`;
    const first = call(suite.baseUrl, path(id), { body, idempotencyKey: requestKey });
    let second: ReturnType<typeof call> | undefined;
    try {
      await waitUntilBlockedOn(suite.sql, ["users", "for update"]);
      second = call(suite.baseUrl, path(id), { body, idempotencyKey: requestKey });
      await waitUntilBlockedOn(suite.sql, ["pg_advisory_xact_lock"]);
    } finally { await connection`commit`; connection.release(); }
    const responses = await Promise.all([first, second]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(responses[0].json).toEqual(responses[1].json);
    expect(responses[0].json.status).toBe("applied");
    expect(await operationCount(requestKey)).toBe(1);
  });

  it("rolls back tier, information and history together when persisting the result fails", async () => {
    const id = await user(); const requestKey = key();
    await suite.sql.unsafe(`create function enterprise29_fail_operation() returns trigger language plpgsql as $$ begin if new.target_user_id = '${id}'::uuid then raise exception 'enterprise test rollback'; end if; return new; end $$`);
    await suite.sql`create trigger enterprise29_fail_operation before insert on enterprise_membership_operations for each row execute function enterprise29_fail_operation()`;
    try {
      const response = await call(suite.baseUrl, path(id), { body, idempotencyKey: requestKey });
      expect(response.status).toBe(500); expect(response.json.code).toBe("internal_error");
      const [account] = await suite.sql<{ membership_tier: string }[]>`select membership_tier from users where id=${id}`;
      expect(account!.membership_tier).toBe("pro");
      expect(await suite.sql`select user_id from enterprise_memberships where user_id=${id}`).toEqual([]);
      expect(await suite.sql`select id from membership_tier_changes where user_id=${id}`).toEqual([]);
      expect(await operationCount(requestKey)).toBe(0);
    } finally {
      await suite.sql`drop trigger enterprise29_fail_operation on enterprise_membership_operations`;
      await suite.sql`drop function enterprise29_fail_operation()`;
    }
    const retry = await call(suite.baseUrl, path(id), { body, idempotencyKey: requestKey });
    expect(retry.status).toBe(200); expect(retry.json.status).toBe("applied");
  });

  it("reports unknown operations as not found", async () => {
    const response = await call(suite.baseUrl, `/internal/v1/enterprise-membership-operations/${key()}`);
    expect(response.status).toBe(404); expect(response.json.code).toBe("not_found");
  });
  it("rolls back a suppressed membership write and permits retry under the original key", async () => {
    const id = await user(); const requestKey = key();
    const name = `enterprise_suppressed_${randomUUID().replaceAll("-", "")}`;
    let functionCreated = false;
    let triggerCreated = false;
    try {
      await suite.sql.unsafe(`create function ${name}() returns trigger language plpgsql as $$ begin if new.user_id = '${id}'::uuid then return null; end if; return new; end $$`);
      functionCreated = true;
      await suite.sql.unsafe(`create trigger ${name} before insert or update on enterprise_memberships for each row execute function ${name}()`);
      triggerCreated = true;
      const response = await call(suite.baseUrl, path(id), { body, idempotencyKey: requestKey });
      expect(response.status).toBe(500); expect(response.json.code).toBe("internal_error");
      const [stored] = await suite.sql<{ membership_tier: string }[]>`select membership_tier from users where id=${id}`;
      expect(stored!.membership_tier).toBe("pro");
      expect(await suite.sql`select user_id from enterprise_memberships where user_id=${id}`).toEqual([]);
      expect(await suite.sql`select id from membership_tier_changes where user_id=${id}`).toEqual([]);
      expect(await operationCount(requestKey)).toBe(0);
    } finally {
      if (triggerCreated) await suite.sql.unsafe(`drop trigger ${name} on enterprise_memberships`);
      if (functionCreated) await suite.sql.unsafe(`drop function ${name}()`);
    }
    const retry = await call(suite.baseUrl, path(id), { body, idempotencyKey: requestKey });
    expect(retry.status).toBe(200); expect(retry.json.status).toBe("applied");
    expect(await operationCount(requestKey)).toBe(1);
  });
});
