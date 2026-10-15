// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Ad conversion queueing (inner#1442 design §4.9) — real PG + Redis.
 *
 * A conversion is queued once, only when `adsAllowed` lets ads run for the
 * browser behind it (or, with none, the account's latest report) and a
 * recent click exists; an upload ads no longer allow is stopped, and the
 * sweep queues again an upload whose job was lost.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, inject } from "vitest";
import crypto from "node:crypto";
import postgres from "postgres";
import { Worker } from "bullmq";
import {
  ADS_CONVERSION_QUEUE,
  createQueue,
  enqueueAdsConversion,
  getUploadStatus,
  initCore,
  ADS_SWEEP_JOB,
  recordReportedConsent,
  requeueStaleAdsUploads,
  scheduleAdsUploadSweep,
  setAdsConversionConfigForTest,
  settleAdsRefused,
  settleAdsUpload,
  unscheduleAdsUploadSweep,
} from "@breatic/core";
import type { AdClick, BrowserAdsSnapshot } from "@breatic/shared";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

let sql: ReturnType<typeof postgres>;
let queue: ReturnType<typeof createQueue>;

const ADS: BrowserAdsSnapshot = { consent: true };
const NO_ADS: BrowserAdsSnapshot = { consent: false };

/**
 * An account with nothing on record.
 * @returns Its id.
 */
async function account(): Promise<string> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email) VALUES (${`ads-${crypto.randomUUID()}@example.test`}) RETURNING id
  `;
  return user!.id;
}

/**
 * The status and failure reason of an upload row.
 * @param txn - Its transaction id.
 * @returns Them.
 */
async function row(txn: string): Promise<{ status: string; failure_reason: string | null }> {
  const [r] = await sql<{ status: string; failure_reason: string | null }[]>`
    SELECT status, failure_reason FROM ads_conversion_uploads WHERE transaction_id = ${txn}
  `;
  return r!;
}
const CONFIG = {
  customerId: "1234567890",
  actions: { signup: "11", credit_purchase: "22" },
  credentials: { client_email: "svc@example.test", private_key: "key" },
};

/**
 * A click from `daysAgo` days back.
 * @param daysAgo - Age of the click.
 * @returns The click.
 */
function clicked(daysAgo: number): AdClick {
  return { gclid: "click-1", at: new Date(Date.now() - daysAgo * 86_400_000).toISOString() };
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

/**
 * The queued job of one transaction.
 * @param transactionId - The transaction.
 * @returns Its data.
 */
async function queuedJob(transactionId: string) {
  const [job] = (await queue.getJobs(["waiting", "delayed", "prioritized"])).filter((j) => j.data.transactionId === transactionId);
  return job!.data;
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
    const input = { userId: await account(), conversion: "signup" as const, transactionId: txn, click: clicked(1) };
    expect(await enqueueAdsConversion(input, ADS)).toBe(true);
    expect(await enqueueAdsConversion(input, ADS)).toBe(false);
    expect(await jobsFor(txn)).toEqual([{ name: "conversion", value: undefined }]);
    expect(await getUploadStatus({ conversion: "signup", transactionId: txn })).toBe("queued");
  });

  it("queues nothing without ads consent, a recent click, a configured action or configuration", async () => {
    const txn = `signup:${crypto.randomUUID()}`;
    expect(await enqueueAdsConversion({ userId: await account(), conversion: "signup", transactionId: txn, click: clicked(1) }, NO_ADS)).toBe(false);
    expect(await enqueueAdsConversion({ userId: await account(), conversion: "signup", transactionId: txn, click: clicked(91) }, ADS)).toBe(false);
    expect(await enqueueAdsConversion({ userId: await account(), conversion: "signup", transactionId: txn, click: null }, ADS)).toBe(false);
    expect(await enqueueAdsConversion({ userId: await account(), conversion: "subscription", transactionId: txn, click: clicked(1) }, ADS)).toBe(false);
    setAdsConversionConfigForTest(null);
    expect(await enqueueAdsConversion({ userId: await account(), conversion: "signup", transactionId: txn, click: clicked(1) }, ADS)).toBe(false);
    expect(await getUploadStatus({ conversion: "signup", transactionId: txn })).toBeNull();
  });

  it("follows the browser behind the event, whatever the account last reported", async () => {
    const txn = `signup:${crypto.randomUUID()}`;
    const input = { conversion: "signup" as const, transactionId: txn, click: clicked(1) };
    const reportedAds = await account();
    await recordReportedConsent(reportedAds, { analytics: true, ads: true });
    expect(await enqueueAdsConversion({ ...input, userId: reportedAds }, NO_ADS)).toBe(false);
    expect(await getUploadStatus({ conversion: "signup", transactionId: txn })).toBeNull();
    const reportedNone = await account();
    await recordReportedConsent(reportedNone, { analytics: false, ads: false });
    expect(await enqueueAdsConversion({ ...input, userId: reportedNone }, ADS)).toBe(true);
  });

  it("queues nothing for a deleted account", async () => {
    const txn = `signup:${crypto.randomUUID()}`;
    const userId = await account();
    await sql`UPDATE users SET deleted_at = now() WHERE id = ${userId}`;
    expect(await enqueueAdsConversion({ userId, conversion: "signup", transactionId: txn, click: clicked(1) }, ADS)).toBe(false);
  });

  it("queues an event no browser is behind under the account's latest report", async () => {
    const txn = `signup:${crypto.randomUUID()}`;
    const input = { conversion: "signup" as const, transactionId: txn, click: clicked(1) };
    expect(await enqueueAdsConversion({ ...input, userId: await account() }, null)).toBe(false);
    const refused = await account();
    await recordReportedConsent(refused, { analytics: true, ads: false });
    expect(await enqueueAdsConversion({ ...input, userId: refused }, null)).toBe(false);
    const userId = await account();
    await recordReportedConsent(userId, { analytics: false, ads: true });
    expect(await enqueueAdsConversion({ ...input, userId }, null)).toBe(true);
  });
});

describe("settling an upload", () => {
  it("fails a queued conversion ads no longer allow with consent_withdrawn", async () => {
    const txn = `signup:${crypto.randomUUID()}`;
    await enqueueAdsConversion({ userId: await account(), conversion: "signup", transactionId: txn, click: clicked(1) }, ADS);
    await settleAdsRefused(await queuedJob(txn));
    expect(await row(txn)).toEqual({ status: "failed", failure_reason: "consent_withdrawn" });
  });

  it("records an upload's outcome once", async () => {
    const sent = `signup:${crypto.randomUUID()}`;
    await enqueueAdsConversion({ userId: await account(), conversion: "signup", transactionId: sent, click: clicked(1) }, ADS);
    const job = await queuedJob(sent);
    await settleAdsUpload(job, true, "req-1");
    expect(await row(sent)).toEqual({ status: "uploaded", failure_reason: null });
    await settleAdsUpload(job, false);
    await settleAdsRefused(job);
    expect(await row(sent)).toEqual({ status: "uploaded", failure_reason: null });

    const refused = `signup:${crypto.randomUUID()}`;
    await enqueueAdsConversion({ userId: await account(), conversion: "signup", transactionId: refused, click: clicked(1) }, ADS);
    await settleAdsUpload(await queuedJob(refused), false);
    expect(await row(refused)).toEqual({ status: "failed", failure_reason: null });
  });
});

describe("requeueStaleAdsUploads", () => {
  it("queues again a conversion whose job never reached the queue, once", async () => {
    const txn = `signup:${crypto.randomUUID()}`;
    expect(await enqueueAdsConversion({ userId: await account(), conversion: "signup", transactionId: txn, click: clicked(1) }, ADS)).toBe(true);
    // The job is lost (Redis down between the claim and the add, or the process died).
    for (const lost of (await queue.getJobs(["waiting", "delayed", "prioritized"])).filter((j) => j.data.transactionId === txn)) {
      await lost.remove();
    }
    await sql`UPDATE ads_conversion_uploads SET updated_at = now() - interval '1 hour' WHERE transaction_id = ${txn}`;
    await requeueStaleAdsUploads(10 * 60_000);
    await requeueStaleAdsUploads(10 * 60_000);
    expect((await jobsFor(txn)).map((j) => j.name)).toEqual(["conversion"]);
  });

  it("replaces a job the queue gave up on while its row still waits", async () => {
    await queue.obliterate({ force: true });
    const txn = `signup:${crypto.randomUUID()}`;
    await enqueueAdsConversion({ userId: await account(), conversion: "signup", transactionId: txn, click: clicked(1) }, ADS);
    // The last attempt failed but its outcome was never recorded (the database was unreachable).
    const worker = new Worker(ADS_CONVERSION_QUEUE, null, { connection: queue.opts.connection, autorun: false });
    const taken = await worker.getNextJob("audit-token");
    taken!.discard();
    await taken!.moveToFailed(new Error("lost"), "audit-token");
    await worker.close();
    expect(await (await queue.getJob(taken!.id!))!.isFailed()).toBe(true);
    await sql`UPDATE ads_conversion_uploads SET updated_at = now() - interval '1 hour' WHERE transaction_id = ${txn}`;
    await requeueStaleAdsUploads(10 * 60_000);
    expect((await jobsFor(txn)).map((j) => j.name)).toEqual(["conversion"]);
  });

  it("leaves an upload already settled alone", async () => {
    const txn = `signup:${crypto.randomUUID()}`;
    await enqueueAdsConversion({ userId: await account(), conversion: "signup", transactionId: txn, click: clicked(1) }, ADS);
    await settleAdsUpload(await queuedJob(txn), true, "req-1");
    await sql`UPDATE ads_conversion_uploads SET updated_at = now() - interval '1 hour' WHERE transaction_id = ${txn}`;
    await requeueStaleAdsUploads(10 * 60_000);
    expect(await row(txn)).toEqual({ status: "uploaded", failure_reason: null });
  });

  it("leaves a recently queued conversion alone", async () => {
    const txn = `signup:${crypto.randomUUID()}`;
    await enqueueAdsConversion({ userId: await account(), conversion: "signup", transactionId: txn, click: clicked(1) }, ADS);
    await requeueStaleAdsUploads(10 * 60_000);
    expect((await jobsFor(txn)).map((j) => j.name)).toEqual(["conversion"]);
  });
});

describe("the upload sweep", () => {
  it("keeps no finished sweep runs, and is gone once ad conversions are switched off", async () => {
    await scheduleAdsUploadSweep();
    const scheduler = await queue.getJobScheduler(ADS_SWEEP_JOB);
    expect(scheduler?.template?.opts).toMatchObject({ removeOnComplete: expect.anything(), removeOnFail: expect.anything() });
    await unscheduleAdsUploadSweep();
    expect(await queue.getJobScheduler(ADS_SWEEP_JOB)).toBeUndefined();
  });
});
