// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Ad conversion queueing (inner#1442 design §4.9) — real PG + Redis.
 *
 * A conversion is queued once, only with ads consent and a recent click, and
 * a refund restates only a conversion that was queued or uploaded.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, inject } from "vitest";
import crypto from "node:crypto";
import postgres from "postgres";
import {
  ADS_CONVERSION_QUEUE,
  createQueue,
  enqueueAdsConversion,
  enqueueAdsRestatement,
  getUploadStatus,
  initCore,
  moveUpload,
  setAdsConversionConfigForTest,
} from "@breatic/core";
import type { Attribution, ConsentSnapshot } from "@breatic/shared";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

let sql: ReturnType<typeof postgres>;
let queue: ReturnType<typeof createQueue>;
const ADS: ConsentSnapshot = { analytics: false, ads: true };
const CONFIG = {
  customerId: "1234567890",
  actions: { signup: "11", credit_purchase: "22" },
  credentials: { client_email: "svc@example.test", private_key: "key" },
};

/**
 * Attribution carrying a click from `daysAgo` days back.
 * @param daysAgo - Age of the click.
 * @returns The attribution.
 */
function clicked(daysAgo: number): Attribution {
  const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  return { first: { gclid: "click-1", at }, last: { gclid: "click-1", at } };
}

/**
 * The queued jobs for one transaction.
 * @param transactionId - The transaction.
 * @returns Job names and data.
 */
async function jobsFor(transactionId: string): Promise<{ name: string; value?: unknown }[]> {
  const jobs = await queue.getJobs(["waiting", "delayed", "prioritized"]);
  return jobs
    .filter((j) => j.data.transactionId === transactionId)
    .map((j) => ({ name: j.name, value: j.data.value }));
}

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false });
  queue = createQueue(ADS_CONVERSION_QUEUE);
  setAdsConversionConfigForTest(CONFIG);
});

afterEach(() => {
  setAdsConversionConfigForTest(CONFIG);
});

afterAll(async () => {
  setAdsConversionConfigForTest(undefined);
  await queue.obliterate({ force: true });
  await sql?.end({ timeout: 5 });
});

describe("enqueueAdsConversion", () => {
  it("queues a conversion once however many times it is reported", async () => {
    const txn = `signup:${crypto.randomUUID()}`;
    const input = { conversion: "signup" as const, transactionId: txn, attribution: clicked(1) };
    expect(await enqueueAdsConversion(input, ADS)).toBe(true);
    expect(await enqueueAdsConversion(input, ADS)).toBe(false);
    expect(await jobsFor(txn)).toEqual([{ name: "conversion", value: undefined }]);
    expect(await getUploadStatus({ conversion: "signup", transactionId: txn })).toBe("queued");
  });

  it("queues nothing without ads consent, a recent click, a configured action or configuration", async () => {
    const txn = `signup:${crypto.randomUUID()}`;
    expect(await enqueueAdsConversion({ conversion: "signup", transactionId: txn, attribution: clicked(1) }, { analytics: true, ads: false })).toBe(false);
    expect(await enqueueAdsConversion({ conversion: "signup", transactionId: txn, attribution: clicked(91) }, ADS)).toBe(false);
    expect(await enqueueAdsConversion({ conversion: "signup", transactionId: txn, attribution: null }, ADS)).toBe(false);
    expect(await enqueueAdsConversion({ conversion: "subscription", transactionId: txn, attribution: clicked(1) }, ADS)).toBe(false);
    setAdsConversionConfigForTest(null);
    expect(await enqueueAdsConversion({ conversion: "signup", transactionId: txn, attribution: clicked(1) }, ADS)).toBe(false);
    expect(await getUploadStatus({ conversion: "signup", transactionId: txn })).toBeNull();
  });
});

describe("enqueueAdsRestatement", () => {
  /**
   * A credit order with a queued conversion.
   * @returns The order id and its transaction id.
   */
  async function purchase(): Promise<{ paymentId: string; txn: string }> {
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO users (email) VALUES (${`ads-${crypto.randomUUID()}@example.test`}) RETURNING id
    `;
    const [source] = await sql<{ id: string }[]>`
      INSERT INTO credit_sources (id, kind) VALUES (gen_random_uuid(), 'payment') RETURNING id
    `;
    await sql`
      INSERT INTO payments (id, user_id, amount_cents, status, credits_granted)
      VALUES (${source!.id}, ${user!.id}, 1000, 'completed', 1000)
    `;
    const txn = `purchase:${crypto.randomUUID()}`;
    await enqueueAdsConversion(
      {
        conversion: "credit_purchase",
        transactionId: txn,
        attribution: clicked(1),
        value: { amountCents: 1000, currency: "USD" },
        paymentId: source!.id,
      },
      ADS,
    );
    return { paymentId: source!.id, txn };
  }

  it("restates an uploaded purchase to zero, once", async () => {
    const { paymentId, txn } = await purchase();
    await moveUpload({ conversion: "credit_purchase", transactionId: txn }, ["queued"], "uploaded");
    expect(await enqueueAdsRestatement(paymentId)).toBe(true);
    expect(await enqueueAdsRestatement(paymentId)).toBe(false);
    expect(await getUploadStatus({ conversion: "credit_purchase", transactionId: txn })).toBe("restating");
    expect(await jobsFor(txn)).toContainEqual({ name: "restatement", value: { amountCents: 0, currency: "USD" } });
  });

  it("does not restate a purchase whose upload failed", async () => {
    const { paymentId, txn } = await purchase();
    await moveUpload({ conversion: "credit_purchase", transactionId: txn }, ["queued"], "failed");
    expect(await enqueueAdsRestatement(paymentId)).toBe(false);
  });

  it("does not restate an order that never had a conversion", async () => {
    expect(await enqueueAdsRestatement(crypto.randomUUID())).toBe(false);
  });
});
