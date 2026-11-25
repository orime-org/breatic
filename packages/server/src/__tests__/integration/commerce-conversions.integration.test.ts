// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Events the billing service reports through the product (inner#1993 §3.3
 * `conversions`): each is sent to analytics and, when it carries one, queued
 * as an ad conversion, once per insert id; `consent: "account"` follows the
 * account's latest reported consent. An account that does not exist or was
 * deleted is refused and nothing is reported.
 */

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { closeDb, initCore, type ConversionReport } from "@breatic/core";
import type * as Core from "@breatic/core";
import { reportConversion } from "@server/modules/commerce/commerce-conversions.service.js";

const track = vi.hoisted(() => vi.fn());
const enqueue = vi.hoisted(() => vi.fn(async () => true));
const accountConsent = vi.hoisted(() => vi.fn(async () => ({ analytics: true, ads: false })));

vi.mock("@breatic/core", async (original) => ({
  ...(await original<typeof Core>()),
  trackServerEvent: track,
  enqueueAdsConversion: enqueue,
  accountOnlyConsent: accountConsent,
}));

let sql: ReturnType<typeof postgres>;
/** The account the reports are about unless a case names another. */
let userId: string;

beforeAll(async () => {
  initCore(process.env);
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false, connection: { application_name: "commerce-conversions-test" } });
  userId = await account();
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  await closeDb();
});

/**
 * One account.
 * @returns Its id.
 */
async function account(): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO users(id,email) VALUES (${id},${`${id}@example.test`})`;
  return id;
}

/**
 * A renewal report.
 * @param overrides - Fields to change.
 * @returns The report.
 */
function report(overrides: Partial<ConversionReport> = {}): ConversionReport {
  return {
    name: "subscription_renewed",
    userId,
    insertId: `evt_${randomUUID()}`,
    properties: { tier: "pro", interval: "month", amount_cents: 2000, currency: "usd" },
    consent: { analytics: true, ads: true },
    ads: null,
    ...overrides,
  };
}

describe("reportConversion", () => {
  it("sends the event with the consent it carries and queues its ad conversion", async () => {
    const r = report({ ads: { conversion: "subscription", transactionId: "sub:x", click: null, value: { amountCents: 2000, currency: "usd" } } });

    const answer = await reportConversion(r);

    expect(answer.httpStatus).toBe(200);
    expect(answer.body).toMatchObject({ adsQueued: true });
    expect(track).toHaveBeenCalledWith("subscription_renewed", { userId: r.userId, insertId: r.insertId, properties: r.properties }, r.consent);
    expect(enqueue).toHaveBeenCalledWith(
      { userId: r.userId, conversion: "subscription", transactionId: "sub:x", click: null, value: { amountCents: 2000, currency: "usd" } },
      { consent: true },
    );
  });

  it("follows the account's consent for \"account\" and queues with no browser behind it", async () => {
    const r = report({ consent: "account", ads: { conversion: "subscription", transactionId: "sub:y", click: null, value: null } });

    await reportConversion(r);

    expect(accountConsent).toHaveBeenCalledWith(r.userId);
    expect(track).toHaveBeenCalledWith("subscription_renewed", expect.anything(), { analytics: true, ads: false });
    expect(enqueue).toHaveBeenCalledWith({ userId: r.userId, conversion: "subscription", transactionId: "sub:y", click: null }, null);
  });

  it("answers a repeat from the first and reports nothing again", async () => {
    const r = report();
    const first = await reportConversion(r);
    vi.clearAllMocks();

    expect(await reportConversion(r)).toEqual(first);
    expect(track).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses the same insert id with another report", async () => {
    const r = report();
    await reportConversion(r);

    expect(await reportConversion({ ...r, properties: {} })).toEqual({ httpStatus: 422, body: { code: "idempotency_key_reused" } });
  });

  it("stores nothing when the ad queue cannot be reached, so a retry reports again", async () => {
    const r = report({ ads: { conversion: "subscription", transactionId: "sub:z", click: null, value: null } });
    enqueue.mockRejectedValueOnce(new Error("redis down"));

    await expect(reportConversion(r)).rejects.toThrow("redis down");
    expect((await reportConversion(r)).httpStatus).toBe(200);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: "a deleted account", deleted: true },
    { name: "an account that does not exist", deleted: false },
  ])("refuses $name and reports nothing", async ({ deleted }) => {
    let id: string = randomUUID();
    if (deleted) {
      id = await account();
      await sql`UPDATE users SET deleted_at = now() WHERE id = ${id}`;
    }
    const r = report({ userId: id, consent: "account", ads: { conversion: "subscription", transactionId: "sub:d", click: null, value: null } });

    expect(await reportConversion(r)).toEqual({ httpStatus: 404, body: { code: "account_not_found" } });
    expect(await reportConversion(r)).toEqual({ httpStatus: 404, body: { code: "account_not_found" } });
    expect(accountConsent).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(await sql`SELECT status FROM commerce_requests WHERE key = ${`conv:${r.insertId}`}`).toEqual([{ status: "refused" }]);
  });
});
