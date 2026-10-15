// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Ad conversion queueing (inner#1442 design §4.9) — real PG + Redis.
 *
 * A conversion is queued once, only when `adsAllowed` lets ads run for the
 * account and the browser behind it and a recent click exists; a refund
 * restates only a conversion that was queued or uploaded, and an opt-out made
 * in between stops the upload or the restatement.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, inject } from "vitest";
import crypto from "node:crypto";
import postgres from "postgres";
import { Worker } from "bullmq";
import {
  ADS_CONVERSION_QUEUE,
  createQueue,
  enqueueAdsConversion,
  enqueueAdsRestatement,
  getUploadStatus,
  initCore,
  moveUpload,
  ADS_SWEEP_JOB,
  cancelPendingAdsRestatement,
  requeueStaleAdsUploads,
  scheduleAdsUploadSweep,
  setAdsConversionConfigForTest,
  settleAdsRefused,
  settleAdsUpload,
  unscheduleAdsUploadSweep,
} from "@breatic/core";
import { CONSENT_REVISION, type AdClick, type BrowserAdsSnapshot } from "@breatic/shared";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

let sql: ReturnType<typeof postgres>;
let queue: ReturnType<typeof createQueue>;

/**
 * The ads side of a browser's consent, as a request snapshot holds it.
 * @param value - Whether the cookie accepts ads; null for no choice.
 * @param gpc - Whether the request carried GPC.
 * @returns The snapshot.
 */
function browser(value: boolean | null, gpc = false): BrowserAdsSnapshot {
  return { consent: value === true, gpc };
}

const ADS = browser(true);

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
 * Close the account's ad switch, as a signed-in opt-out would.
 * @param userId - The account.
 * @param source - What closed it.
 */
async function optOut(userId: string, source: "settings" | "gpc" = "settings"): Promise<void> {
  await sql`UPDATE users SET ads_opted_out_at = now(), ads_opt_out_source = ${source} WHERE id = ${userId}`;
}

/**
 * Record ads consent as the choice last seen on a signed-in request.
 * @param userId - The account.
 */
async function seenAdsConsent(userId: string): Promise<void> {
  await sql`UPDATE users SET consent_seen = ${sql.json({ ads: { value: true, revision: CONSENT_REVISION } })} WHERE id = ${userId}`;
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
    expect(await enqueueAdsConversion({ userId: await account(), conversion: "signup", transactionId: txn, click: clicked(1) }, browser(false))).toBe(false);
    expect(await enqueueAdsConversion({ userId: await account(), conversion: "signup", transactionId: txn, click: clicked(91) }, ADS)).toBe(false);
    expect(await enqueueAdsConversion({ userId: await account(), conversion: "signup", transactionId: txn, click: null }, ADS)).toBe(false);
    expect(await enqueueAdsConversion({ userId: await account(), conversion: "subscription", transactionId: txn, click: clicked(1) }, ADS)).toBe(false);
    setAdsConversionConfigForTest(null);
    expect(await enqueueAdsConversion({ userId: await account(), conversion: "signup", transactionId: txn, click: clicked(1) }, ADS)).toBe(false);
    expect(await getUploadStatus({ conversion: "signup", transactionId: txn })).toBeNull();
  });

  it("queues nothing when the account or the request opted out, or the browser has no choice", async () => {
    const txn = `signup:${crypto.randomUUID()}`;
    const input = { conversion: "signup" as const, transactionId: txn, click: clicked(1) };
    const refused = await account();
    await optOut(refused);
    expect(await enqueueAdsConversion({ ...input, userId: refused }, ADS)).toBe(false);
    const gpcAccount = await account();
    await optOut(gpcAccount, "gpc");
    expect(await enqueueAdsConversion({ ...input, userId: gpcAccount }, ADS)).toBe(false);
    expect(await enqueueAdsConversion({ ...input, userId: await account() }, browser(true, true))).toBe(false);
    const withConsent = await account();
    await seenAdsConsent(withConsent);
    expect(await enqueueAdsConversion({ ...input, userId: withConsent }, browser(null))).toBe(false);
    expect(await getUploadStatus({ conversion: "signup", transactionId: txn })).toBeNull();
  });

  it("queues nothing for a deleted account", async () => {
    const txn = `signup:${crypto.randomUUID()}`;
    const userId = await account();
    await sql`UPDATE users SET deleted_at = now() WHERE id = ${userId}`;
    expect(await enqueueAdsConversion({ userId, conversion: "signup", transactionId: txn, click: clicked(1) }, ADS)).toBe(false);
  });

  it("queues an event no browser is behind under the ads choice last seen", async () => {
    const txn = `signup:${crypto.randomUUID()}`;
    const input = { conversion: "signup" as const, transactionId: txn, click: clicked(1) };
    expect(await enqueueAdsConversion({ ...input, userId: await account() }, null)).toBe(false);
    const userId = await account();
    await seenAdsConsent(userId);
    expect(await enqueueAdsConversion({ ...input, userId }, null)).toBe(true);
  });
});

describe("settleAdsRefused", () => {
  it("fails a queued conversion and a queued restatement with consent_withdrawn", async () => {
    const txn = `signup:${crypto.randomUUID()}`;
    const userId = await account();
    await enqueueAdsConversion({ userId, conversion: "signup", transactionId: txn, click: clicked(1) }, ADS);
    const [job] = (await queue.getJobs(["waiting", "delayed", "prioritized"])).filter((j) => j.data.transactionId === txn);
    await settleAdsRefused(job!.data);
    expect(await row(txn)).toEqual({ status: "failed", failure_reason: "consent_withdrawn" });

    const restated = `signup:${crypto.randomUUID()}`;
    await enqueueAdsConversion({ userId, conversion: "signup", transactionId: restated, click: clicked(1) }, ADS);
    await moveUpload({ conversion: "signup", transactionId: restated }, ["queued"], "restating");
    const [original] = (await queue.getJobs(["waiting", "delayed", "prioritized"])).filter(
      (j) => j.data.transactionId === restated,
    );
    await settleAdsRefused({ ...original!.data, kind: "restatement" });
    expect(await row(restated)).toEqual({ status: "restate_failed", failure_reason: "consent_withdrawn" });
  });
});

/**
 * A credit order with a queued conversion.
 * @returns The order id and its transaction id.
 */
async function purchase(): Promise<{ paymentId: string; txn: string; userId: string }> {
  const userId = await account();
  const [source] = await sql<{ id: string }[]>`
    INSERT INTO credit_sources (id, kind) VALUES (gen_random_uuid(), 'payment') RETURNING id
  `;
  await sql`
    INSERT INTO payments (id, user_id, amount_cents, status, credits_granted)
    VALUES (${source!.id}, ${userId}, 1000, 'completed', 1000)
  `;
  const txn = `purchase:${crypto.randomUUID()}`;
  await enqueueAdsConversion(
    {
      userId,
      conversion: "credit_purchase",
      transactionId: txn,
      click: clicked(1),
      value: { amountCents: 1000, currency: "USD" },
      paymentId: source!.id,
    },
    ADS,
  );
  return { paymentId: source!.id, txn, userId };
}

/**
 * Book a purchase's refund: its credit lot is refunded.
 * @param paymentId - The order.
 * @param userId - Its buyer.
 */
async function refunded(paymentId: string, userId: string): Promise<void> {
  await sql`
    INSERT INTO credit_lots (source_id, source_kind, user_id, purchased_credits, remaining_credits, lifecycle)
    VALUES (${paymentId}, 'payment', ${userId}, 1000, 0, 'refunded')
  `;
}

describe("enqueueAdsRestatement", () => {
  it("restates an uploaded purchase to zero, once", async () => {
    const { paymentId, txn } = await purchase();
    await moveUpload({ conversion: "credit_purchase", transactionId: txn }, ["queued"], "uploaded");
    expect(await enqueueAdsRestatement(paymentId)).toBe("queued");
    expect(await enqueueAdsRestatement(paymentId)).toBe("none");
    expect(await getUploadStatus({ conversion: "credit_purchase", transactionId: txn })).toBe("restating");
    expect(await jobsFor(txn)).toContainEqual({ name: "restatement", value: { amountCents: 0, currency: "USD" } });
  });

  it("restates a purchase refunded while queued only after its upload lands", async () => {
    const { paymentId, txn } = await purchase();
    const key = { conversion: "credit_purchase" as const, transactionId: txn };
    expect(await enqueueAdsRestatement(paymentId)).toBe("after_upload");
    expect(await getUploadStatus(key)).toBe("restate_pending");
    expect((await jobsFor(txn)).map((j) => j.name)).toEqual(["conversion"]);

    const [job] = (await queue.getJobs(["waiting", "delayed", "prioritized"])).filter((j) => j.data.transactionId === txn);
    await settleAdsUpload(job!.data, true, "req-1");
    expect(await getUploadStatus(key)).toBe("restating");
    expect(await jobsFor(txn)).toContainEqual({ name: "restatement", value: { amountCents: 0, currency: "USD" } });
    const restatement = (await queue.getJobs(["waiting", "delayed", "prioritized"])).find(
      (j) => j.data.transactionId === txn && j.name === "restatement",
    );
    expect(restatement?.data.originalRequestId).toBe("req-1");

    await settleAdsUpload({ ...job!.data, kind: "restatement" }, true);
    expect(await getUploadStatus(key)).toBe("restated");
  });

  it("drops a pending restatement when the upload finally fails", async () => {
    const { paymentId, txn } = await purchase();
    await enqueueAdsRestatement(paymentId);
    const [job] = (await queue.getJobs(["waiting", "delayed", "prioritized"])).filter((j) => j.data.transactionId === txn);
    await settleAdsUpload(job!.data, false);
    expect(await getUploadStatus({ conversion: "credit_purchase", transactionId: txn })).toBe("failed");
    expect((await jobsFor(txn)).map((j) => j.name)).toEqual(["conversion"]);
  });

  it("keeps an uploaded purchase as it is when ads were withdrawn before the refund", async () => {
    const { paymentId, txn, userId } = await purchase();
    await moveUpload({ conversion: "credit_purchase", transactionId: txn }, ["queued"], "uploaded");
    await optOut(userId);
    expect(await enqueueAdsRestatement(paymentId)).toBe("consent_withdrawn");
    expect(await row(txn)).toEqual({ status: "uploaded", failure_reason: "consent_withdrawn" });
  });

  it("does not forward a pending restatement when ads were withdrawn before the upload landed", async () => {
    const { paymentId, txn, userId } = await purchase();
    await enqueueAdsRestatement(paymentId);
    await optOut(userId);
    const [job] = (await queue.getJobs(["waiting", "delayed", "prioritized"])).filter((j) => j.data.transactionId === txn);
    expect(await settleAdsUpload(job!.data, true, "req-1")).toBe(true);
    expect(await row(txn)).toEqual({ status: "uploaded", failure_reason: "consent_withdrawn" });
    expect((await jobsFor(txn)).map((j) => j.name)).toEqual(["conversion"]);
  });

  it("does not restate a purchase whose upload failed", async () => {
    const { paymentId, txn } = await purchase();
    await moveUpload({ conversion: "credit_purchase", transactionId: txn }, ["queued"], "failed");
    expect(await enqueueAdsRestatement(paymentId)).toBe("none");
  });

  it("does not restate an order that never had a conversion", async () => {
    expect(await enqueueAdsRestatement(crypto.randomUUID())).toBe("none");
  });
});

describe("cancelPendingAdsRestatement", () => {
  it("puts a restatement still waiting on its upload back, so the restored purchase keeps its value", async () => {
    const { paymentId, txn } = await purchase();
    await enqueueAdsRestatement(paymentId);
    expect(await cancelPendingAdsRestatement(paymentId)).toBe("cancelled");
    expect(await getUploadStatus({ conversion: "credit_purchase", transactionId: txn })).toBe("queued");
    const [job] = (await queue.getJobs(["waiting", "delayed", "prioritized"])).filter((j) => j.data.transactionId === txn);
    await settleAdsUpload(job!.data, true, "req-1");
    expect(await getUploadStatus({ conversion: "credit_purchase", transactionId: txn })).toBe("uploaded");
    expect((await jobsFor(txn)).map((j) => j.name)).toEqual(["conversion"]);
  });

  it("reports a restatement already on its way or sent", async () => {
    const { paymentId, txn } = await purchase();
    await moveUpload({ conversion: "credit_purchase", transactionId: txn }, ["queued"], "uploaded");
    await enqueueAdsRestatement(paymentId);
    expect(await cancelPendingAdsRestatement(paymentId)).toBe("restating");
    await moveUpload({ conversion: "credit_purchase", transactionId: txn }, ["restating"], "restated");
    expect(await cancelPendingAdsRestatement(paymentId)).toBe("restated");
  });

  it("does nothing when no restatement was asked for", async () => {
    const { paymentId } = await purchase();
    expect(await cancelPendingAdsRestatement(paymentId)).toBe("none");
    expect(await cancelPendingAdsRestatement(crypto.randomUUID())).toBe("none");
  });
});

describe("requeueStaleAdsUploads", () => {
  it("restates a refunded purchase whose restatement was never asked for", async () => {
    const { paymentId, txn, userId } = await purchase();
    const key = { conversion: "credit_purchase" as const, transactionId: txn };
    await moveUpload(key, ["queued"], "uploaded");
    await refunded(paymentId, userId);
    await sql`UPDATE ads_conversion_uploads SET updated_at = now() - interval '1 hour' WHERE transaction_id = ${txn}`;
    await requeueStaleAdsUploads(10 * 60_000);
    expect(await getUploadStatus(key)).toBe("restating");
    expect(await jobsFor(txn)).toContainEqual({ name: "restatement", value: { amountCents: 0, currency: "USD" } });
  });

  it("marks a refunded purchase whose account opted out, and does not ask again", async () => {
    const { paymentId, txn, userId } = await purchase();
    await moveUpload({ conversion: "credit_purchase", transactionId: txn }, ["queued"], "uploaded");
    await refunded(paymentId, userId);
    await optOut(userId);
    await sql`UPDATE ads_conversion_uploads SET updated_at = now() - interval '1 hour' WHERE transaction_id = ${txn}`;
    await requeueStaleAdsUploads(10 * 60_000);
    expect(await row(txn)).toEqual({ status: "uploaded", failure_reason: "consent_withdrawn" });
    await sql`UPDATE users SET ads_opted_out_at = NULL, ads_opt_out_source = NULL WHERE id = ${userId}`;
    await sql`UPDATE ads_conversion_uploads SET updated_at = now() - interval '1 hour' WHERE transaction_id = ${txn}`;
    await requeueStaleAdsUploads(10 * 60_000);
    expect(await row(txn)).toEqual({ status: "uploaded", failure_reason: "consent_withdrawn" });
  });

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

  it("queues again the conversion of a refund waiting on an upload whose job was lost", async () => {
    const txn = `signup:${crypto.randomUUID()}`;
    const key = { conversion: "signup" as const, transactionId: txn };
    await enqueueAdsConversion({ userId: await account(), conversion: "signup", transactionId: txn, click: clicked(1) }, ADS);
    await moveUpload(key, ["queued"], "restate_pending");
    for (const lost of (await queue.getJobs(["waiting", "delayed", "prioritized"])).filter((j) => j.data.transactionId === txn)) {
      await lost.remove();
    }
    await sql`UPDATE ads_conversion_uploads SET updated_at = now() - interval '1 hour' WHERE transaction_id = ${txn}`;
    await requeueStaleAdsUploads(10 * 60_000);
    expect((await jobsFor(txn)).map((j) => j.name)).toEqual(["conversion"]);
    expect(await getUploadStatus(key)).toBe("restate_pending");
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

  it("queues again a restatement whose job was lost", async () => {
    const txn = `signup:${crypto.randomUUID()}`;
    const key = { conversion: "signup" as const, transactionId: txn };
    await enqueueAdsConversion({ userId: await account(), conversion: "signup", transactionId: txn, click: clicked(1) }, ADS);
    await moveUpload(key, ["queued"], "restating");
    for (const lost of (await queue.getJobs(["waiting", "delayed", "prioritized"])).filter((j) => j.data.transactionId === txn)) {
      await lost.remove();
    }
    await sql`UPDATE ads_conversion_uploads SET updated_at = now() - interval '1 hour' WHERE transaction_id = ${txn}`;
    await requeueStaleAdsUploads(10 * 60_000);
    expect((await jobsFor(txn)).map((j) => j.name)).toEqual(["restatement"]);
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
