// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { initCore, loadLocales } from "@breatic/core";

import { submitApplication } from "@server/modules/referral/promoter-application.service";
import { approve } from "@server/modules/referral/referral-admin.service";
import { waitUntilBlockedOn } from "./lock-probe";

const TERMS = "2026-11-07";
let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  initCore(process.env);
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false, connection: { application_name: "promoter-application-test" } });
});
afterAll(async () => { await sql?.end({ timeout: 1 }); });

/**
 * Inserts an account.
 * @returns Its id.
 */
async function account(): Promise<string> {
  const id = randomUUID();
  await sql`insert into users(id,email) values(${id},${`${id}@example.test`})`;
  return id;
}

const form = { country: "SG", channels: ["https://youtube.com/@me", "a 200-person designers group"], plan: "Tutorials", termsVersion: TERMS };

/**
 * Reads an account's applications, oldest first.
 * @param userId - The account.
 * @returns Status and terms of each.
 */
async function applicationsOf(userId: string): Promise<{ status: string; terms_version: string; country: string; accepted: boolean }[]> {
  return sql`select status, terms_version, country, terms_accepted_at is not null as accepted
    from promoter_applications where user_id = ${userId} order by created_at, id`;
}

describe("submitApplication", () => {
  it("keeps the program closed while no terms version is published", async () => {
    const userId = await account();
    expect(await submitApplication(userId, form, "")).toEqual({ ok: false, reason: "program_closed" });
    expect(await applicationsOf(userId)).toEqual([]);
  });

  it("refuses an agreement to terms that are no longer current and names the current version", async () => {
    const userId = await account();
    expect(await submitApplication(userId, { ...form, termsVersion: "2026-01-01" }, TERMS)).toEqual({
      ok: false, reason: "terms_changed", termsVersion: TERMS,
    });
    expect(await applicationsOf(userId)).toEqual([]);
  });

  it("files a pending application with the terms agreed to and when", async () => {
    const userId = await account();
    expect(await submitApplication(userId, form, TERMS)).toEqual({ ok: true });
    expect(await applicationsOf(userId)).toEqual([{ status: "pending", terms_version: TERMS, country: "SG", accepted: true }]);
  });

  it("refuses a second application while one is under review, even when both arrive together", async () => {
    const userId = await account();
    const outcomes = await Promise.all([submitApplication(userId, form, TERMS), submitApplication(userId, form, TERMS)]);
    expect(outcomes).toContainEqual({ ok: true });
    expect(outcomes).toContainEqual({ ok: false, reason: "application_pending" });
    expect(await submitApplication(userId, form, TERMS)).toEqual({ ok: false, reason: "application_pending" });
    expect(await applicationsOf(userId)).toHaveLength(1);
  });

  it("files a new application after a rejection", async () => {
    const userId = await account();
    await submitApplication(userId, form, TERMS);
    await sql`update promoter_applications set status='rejected', decided_at=now(), decided_by='admin_7' where user_id=${userId}`;
    expect(await submitApplication(userId, form, TERMS)).toEqual({ ok: true });
    expect((await applicationsOf(userId)).map((a) => a.status)).toEqual(["rejected", "pending"]);
  });

  it("refuses an approved promoter as already_promoter", async () => {
    const userId = await account();
    await submitApplication(userId, form, TERMS);
    await sql`update promoter_applications set status='approved', decided_at=now(), decided_by='admin_7' where user_id=${userId}`;
    expect(await submitApplication(userId, form, TERMS)).toEqual({ ok: false, reason: "already_promoter" });
  });

  it("takes the account's lock for an application and its approval, so an approved promoter is never left a second pending one", async () => {
    // Without the lock a submit that read the pending application before the
    // approval committed inserts after it, and approving that one fails on the
    // promoter's unique code.
    const userId = await account();
    await submitApplication(userId, form, TERMS);
    const [first] = await sql<{ id: string }[]>`select id from promoter_applications where user_id = ${userId}`;

    const gate = postgres(inject("DATABASE_URL"), { max: 1, prepare: false });
    let again: ReturnType<typeof submitApplication>;
    let approval: ReturnType<typeof approve>;
    try {
      await gate.begin(async (g) => {
        await g`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
        again = submitApplication(userId, form, TERMS);
        await waitUntilBlockedOn(sql, ["users", "for update"], 1);
        approval = approve(first!.id, { reason: "ok" }, { key: `bo-${randomUUID()}`, hash: "0".repeat(64), adminId: "admin_7" });
        await waitUntilBlockedOn(sql, ["users", "for update"], 2);
      });
    } finally {
      await gate.end({ timeout: 5 });
    }

    expect((await approval!).body).toMatchObject({ status: "applied" });
    expect([{ ok: false, reason: "application_pending" }, { ok: false, reason: "already_promoter" }]).toContainEqual(await again!);
    expect((await applicationsOf(userId)).map((a) => a.status)).toEqual(["approved"]);
  });
});
