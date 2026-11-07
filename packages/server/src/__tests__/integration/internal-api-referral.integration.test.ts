// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ADMIN, call, useInternalApp } from "./internal-api-harness.js";

const suite = useInternalApp("internal-api-referral");

/** A back-office confirmation key in the agreed format. */
function key(): string {
  return `bo-${randomUUID()}`;
}

/**
 * Inserts an account with a pending application.
 * @param email - Optional fixed email.
 * @returns The account and its application.
 */
async function applicant(email?: string): Promise<{ userId: string; applicationId: string; email: string }> {
  const userId = randomUUID();
  const address = email ?? `${userId}@example.test`;
  await suite.sql`insert into users(id,email) values(${userId},${address})`;
  const [row] = await suite.sql<{ id: string }[]>`insert into promoter_applications
    (user_id,status,country,channels,plan,terms_version,terms_accepted_at)
    values(${userId},'pending','SG',${suite.sql.json(["https://example.test/me"])},'Tutorials','2026-11-07',now()) returning id`;
  return { userId, applicationId: row!.id, email: address };
}

/**
 * Approves an application through the API.
 * @param applicationId - The application.
 * @param body - The approval body.
 * @returns The response.
 */
function approve(applicationId: string, body: Record<string, unknown> = { reason: "Good channels" }): ReturnType<typeof call> {
  return call(suite.baseUrl, `/internal/v1/promoter-applications/${applicationId}/approve`, { body, idempotencyKey: key() });
}

/**
 * Writes to a code through the API.
 * @param codeId - The code row.
 * @param action - disable, enable or remove.
 * @returns The response.
 */
function codeWrite(codeId: string, action: "disable" | "enable" | "remove"): ReturnType<typeof call> {
  return call(suite.baseUrl, `/internal/v1/referral-codes/${codeId}/${action}`, { body: { reason: `${action} for test` }, idempotencyKey: key() });
}

/**
 * Creates an approved promoter and returns the code row.
 * @returns The code row id and the promoter.
 */
async function approvedCode(): Promise<{ codeId: string; userId: string }> {
  const { userId, applicationId } = await applicant();
  const res = await approve(applicationId);
  expect(res.json.status).toBe("applied");
  const [row] = await suite.sql<{ id: string }[]>`select id from referral_codes where promoter_id = ${userId}`;
  return { codeId: row!.id, userId };
}

describe("approving a promoter application", () => {
  it("approves with the code asked for, stored upper-case, and records who and why", async () => {
    const { userId, applicationId } = await applicant();
    const wanted = `ali-${randomUUID().slice(0, 6)}`;
    const res = await approve(applicationId, { reason: "Good channels", code: wanted });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: "applied", referralCode: wanted.toUpperCase() });
    const [app] = await suite.sql`select status, decided_by, decision_reason from promoter_applications where id = ${applicationId}`;
    expect(app).toEqual({ status: "approved", decided_by: ADMIN, decision_reason: "Good channels" });
    const [code] = await suite.sql`select code, status, promoter_id from referral_codes where application_id = ${applicationId}`;
    expect(code).toEqual({ code: wanted.toUpperCase(), status: "active", promoter_id: userId });
  });

  it("generates an eight-character code when none is asked for", async () => {
    const { applicationId } = await applicant();
    const res = await approve(applicationId);
    expect(res.json.status).toBe("applied");
    expect(res.json.referralCode).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
  });

  it("refuses a code already held by someone else as code_taken and leaves the application pending", async () => {
    const first = await applicant();
    const wanted = `TAKEN${randomUUID().slice(0, 6).toUpperCase()}`;
    await approve(first.applicationId, { reason: "first", code: wanted });
    const second = await applicant();
    const res = await approve(second.applicationId, { reason: "second", code: wanted.toLowerCase() });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: "refused", code: "code_taken" });
    const [app] = await suite.sql`select status from promoter_applications where id = ${second.applicationId}`;
    expect(app!.status).toBe("pending");
  });

  it("refuses an asked-for code the database cannot store as a malformed body", async () => {
    const { applicationId } = await applicant();
    const res = await approve(applicationId, { reason: "x", code: "AB\u0000CD" });
    expect(res.status).toBe(422);
    const [app] = await suite.sql`select status from promoter_applications where id = ${applicationId}`;
    expect(app!.status).toBe("pending");
  });

  it("refuses a malformed code as invalid_code", async () => {
    const { applicationId } = await applicant();
    const res = await approve(applicationId, { reason: "x", code: "a!" });
    expect(res.json).toMatchObject({ status: "refused", code: "invalid_code" });
  });

  it("refuses an application that is no longer pending as not_pending", async () => {
    const { applicationId } = await applicant();
    await approve(applicationId);
    const again = await approve(applicationId);
    expect(again.json).toMatchObject({ status: "refused", code: "not_pending" });
    const reject = await call(suite.baseUrl, `/internal/v1/promoter-applications/${applicationId}/reject`, { body: { reason: "late" }, idempotencyKey: key() });
    expect(reject.json).toMatchObject({ status: "refused", code: "not_pending" });
  });

  it("lets only one of two concurrent approvals apply", async () => {
    const { applicationId } = await applicant();
    const results = await Promise.all([approve(applicationId), approve(applicationId)]);
    expect(results.map((r) => r.json.status).sort()).toEqual(["applied", "refused"]);
    const codes = await suite.sql`select id from referral_codes where application_id = ${applicationId}`;
    expect(codes).toHaveLength(1);
  });

  it("replays the original answer for the same key and body, and refuses the same key with another body", async () => {
    const { applicationId } = await applicant();
    const k = key();
    const path = `/internal/v1/promoter-applications/${applicationId}/approve`;
    const first = await call(suite.baseUrl, path, { body: { reason: "r" }, idempotencyKey: k });
    const replay = await call(suite.baseUrl, path, { body: { reason: "r" }, idempotencyKey: k });
    expect(replay.status).toBe(200);
    expect(replay.json).toEqual(first.json);
    const conflict = await call(suite.baseUrl, path, { body: { reason: "other" }, idempotencyKey: k });
    expect(conflict.status).toBe(409);
    expect(conflict.json).toEqual({ code: "idempotency_conflict" });
    const original = await call(suite.baseUrl, `/internal/v1/referral-operations/${k}`);
    expect(original.json).toEqual(first.json);
  });

  it("answers 404 for an application that does not exist", async () => {
    const res = await approve(randomUUID());
    expect(res.status).toBe(404);
  });
});

describe("rejecting a promoter application", () => {
  it("rejects with a note the applicant will see", async () => {
    const { applicationId } = await applicant();
    const res = await call(suite.baseUrl, `/internal/v1/promoter-applications/${applicationId}/reject`, {
      body: { reason: "Channels unreachable", applicantNote: "Your links did not open." }, idempotencyKey: key(),
    });
    expect(res.json).toMatchObject({ status: "applied" });
    const [app] = await suite.sql`select status, applicant_note, decision_reason from promoter_applications where id = ${applicationId}`;
    expect(app).toEqual({ status: "rejected", applicant_note: "Your links did not open.", decision_reason: "Channels unreachable" });
  });

  it.each(["a\u0000b", "a\ud800b"])("refuses a note the database cannot store (%j) as a malformed body", async (note) => {
    const { applicationId } = await applicant();
    const res = await call(suite.baseUrl, `/internal/v1/promoter-applications/${applicationId}/reject`, {
      body: { reason: "Channels unreachable", applicantNote: note }, idempotencyKey: key(),
    });
    expect(res.status).toBe(422);
    const [app] = await suite.sql`select status from promoter_applications where id = ${applicationId}`;
    expect(app!.status).toBe("pending");
  });
});

describe("managing a referral code", () => {
  it("disables, refuses a second disable, re-enables and refuses a second enable", async () => {
    const { codeId } = await approvedCode();
    expect((await codeWrite(codeId, "disable")).json).toMatchObject({ status: "applied" });
    expect((await codeWrite(codeId, "disable")).json).toMatchObject({ status: "refused", code: "already_disabled" });
    expect((await codeWrite(codeId, "enable")).json).toMatchObject({ status: "applied" });
    expect((await codeWrite(codeId, "enable")).json).toMatchObject({ status: "refused", code: "already_active" });
  });

  it("removes a promoter for good: the code cannot be disabled, enabled or removed again", async () => {
    const { codeId } = await approvedCode();
    await codeWrite(codeId, "disable");
    expect((await codeWrite(codeId, "remove")).json).toMatchObject({ status: "applied" });
    const [row] = await suite.sql`select status, removed_at is not null as stamped from referral_codes where id = ${codeId}`;
    expect(row).toEqual({ status: "removed", stamped: true });
    expect((await codeWrite(codeId, "enable")).json).toMatchObject({ status: "refused", code: "removed" });
    expect((await codeWrite(codeId, "disable")).json).toMatchObject({ status: "refused", code: "removed" });
    expect((await codeWrite(codeId, "remove")).json).toMatchObject({ status: "refused", code: "already_removed" });
  });

  it("answers 404 for a code that does not exist", async () => {
    expect((await codeWrite(randomUUID(), "disable")).status).toBe(404);
  });
});

describe("reading applications and codes", () => {
  it("shows an application with the applicant's email, the terms agreed to and the code issued", async () => {
    const { applicationId, email } = await applicant();
    await approve(applicationId, { reason: "ok", code: `DET${randomUUID().slice(0, 6).toUpperCase()}` });
    const res = await call(suite.baseUrl, `/internal/v1/promoter-applications/${applicationId}`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      id: applicationId, status: "approved", email, country: "SG", termsVersion: "2026-11-07",
      channels: ["https://example.test/me"], plan: "Tutorials",
    });
    expect(res.json.referralCode).toMatch(/^DET/);
    expect(typeof res.json.termsAcceptedAt).toBe("string");
  });

  it("pages pending applications newest first with a cursor", async () => {
    const created = [await applicant(), await applicant(), await applicant()];
    const first = await call(suite.baseUrl, "/internal/v1/promoter-applications?status=pending&pageSize=2");
    expect(first.status).toBe(200);
    expect(first.json.items).toHaveLength(2);
    expect(first.json.items.every((i: { status: string }) => i.status === "pending")).toBe(true);
    expect(first.json.items[0].id).toBe(created[2]!.applicationId);
    const next = await call(suite.baseUrl, `/internal/v1/promoter-applications?status=pending&pageSize=2&cursor=${encodeURIComponent(first.json.nextCursor)}`);
    expect(next.json.items[0].id).toBe(created[0]!.applicationId);
  });

  it("lists codes with how many accounts are bound to each", async () => {
    const { codeId } = await approvedCode();
    for (let i = 0; i < 2; i += 1) {
      const id = randomUUID();
      await suite.sql`insert into users(id,email) values(${id},${`${id}@example.test`})`;
      await suite.sql`insert into referral_bindings(user_id,referral_code_id,source) values(${id},${codeId},'later')`;
    }
    const res = await call(suite.baseUrl, "/internal/v1/referral-codes?status=active&pageSize=100");
    const item = res.json.items.find((i: { id: string }) => i.id === codeId);
    expect(item).toMatchObject({ status: "active", boundAccounts: 2 });
    expect(typeof item.email).toBe("string");
  });

  it("answers 404 for an operation key never used", async () => {
    expect((await call(suite.baseUrl, `/internal/v1/referral-operations/${key()}`)).status).toBe(404);
  });
});
