// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A queued ad conversion. The handler uploads it, records how it ended, and
 * leaves a failure the platform might recover from to the queue's retries.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DelayedError, UnrecoverableError, type Job } from "bullmq";

import type * as CoreModule from "@breatic/core";

const settleAdsUpload = vi.hoisted(() => vi.fn(async () => undefined));
const requeueStaleAdsUploads = vi.hoisted(() => vi.fn(async () => 0));
const adsConversionConfig = vi.hoisted(() => vi.fn());
const getUploadStatus = vi.hoisted(() => vi.fn(async (): Promise<string | null> => "queued"));
const ingestEvents = vi.hoisted(() => vi.fn(async () => [{ requestId: "req-1" }]));
const retrieveRequestStatus = vi.hoisted(() =>
  vi.fn(async () => [{ requestStatusPerDestination: [{ requestStatus: "SUCCESS" }] }]),
);

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return { ...actual, settleAdsUpload, adsConversionConfig, requeueStaleAdsUploads, getUploadStatus };
});
vi.mock("@google-ads/datamanager", () => ({
  IngestionServiceClient: class {
    ingestEvents = ingestEvents;
    retrieveRequestStatus = retrieveRequestStatus;
  },
}));

import type { AdsConversionJob } from "@breatic/core";
import { googleDataManagerSink, runAdsConversion, type AdsConversionSink } from "@worker/handlers/ads-conversion.js";

const CONFIG = {
  customerId: "1234567890",
  actions: { credit_purchase: "22" },
  credentials: { client_email: "svc@example.test", private_key: "key" },
};

const DATA: AdsConversionJob = {
  kind: "conversion",
  conversion: "credit_purchase",
  transactionId: "purchase:cs_1",
  occurredAt: "2026-10-12T01:00:00.000Z",
  click: { gclid: "click-1", at: "2026-10-11T01:00:00.000Z" },
  value: { amountCents: 1999, currency: "usd" },
};

/**
 * A queued job on the given attempt.
 * @param attemptsMade - Attempts already made.
 * @returns The job.
 */
function job(attemptsMade = 0, data: AdsConversionJob = DATA, queuedAgoMs = 0): Job<AdsConversionJob> {
  return {
    name: data.kind,
    data,
    attemptsMade,
    opts: { attempts: 5 },
    timestamp: Date.now() - queuedAgoMs,
    updateData: vi.fn(async () => undefined),
    moveToDelayed: vi.fn(async () => undefined),
  } as unknown as Job<AdsConversionJob>;
}

const MINUTE = 60_000;

const RESTATEMENT: AdsConversionJob = {
  ...DATA,
  kind: "restatement",
  value: { amountCents: 0, currency: "USD" },
  originalRequestId: "req-0",
};

/**
 * A sink whose upload succeeds and whose status lookup answers as given.
 * @param status - What the original request's processing came to.
 * @returns The sink.
 */
function sinkWithStatus(status: "success" | "processing" | "failed"): AdsConversionSink {
  return { upload: vi.fn(async () => "req-2"), status: vi.fn(async () => status) };
}

beforeEach(() => {
  vi.clearAllMocks();
  adsConversionConfig.mockReturnValue(CONFIG);
  getUploadStatus.mockImplementation(async () => "queued");
});

describe("runAdsConversion", () => {
  it("uploads and records the upload", async () => {
    const sink: AdsConversionSink = { upload: vi.fn(async () => "req-1"), status: vi.fn() };
    await runAdsConversion(job(), sink);
    expect(sink.upload).toHaveBeenCalledWith(DATA, "22");
    expect(settleAdsUpload).toHaveBeenCalledWith(DATA, true, "req-1");
  });

  it("restates only once Google has processed the original upload", async () => {
    getUploadStatus.mockResolvedValue("restating");
    const sink = sinkWithStatus("success");
    await runAdsConversion(job(0, RESTATEMENT), sink);
    expect(sink.status).toHaveBeenCalledWith("req-0");
    expect(sink.upload).toHaveBeenCalledWith(RESTATEMENT, "22");
    expect(settleAdsUpload).toHaveBeenCalledWith(RESTATEMENT, true, "req-2");
  });

  it("checks again in 30 minutes while Google is still processing the original upload, spending no attempt", async () => {
    getUploadStatus.mockResolvedValue("restating");
    const sink = sinkWithStatus("processing");
    const queued = job(0, RESTATEMENT);
    const before = Date.now();
    await expect(runAdsConversion(queued, sink, "token")).rejects.toBeInstanceOf(DelayedError);
    const [until, token] = vi.mocked(queued.moveToDelayed).mock.calls[0]!;
    expect(token).toBe("token");
    expect(until - before).toBeGreaterThanOrEqual(30 * MINUTE);
    expect(until - before).toBeLessThan(34 * MINUTE);
    expect(queued.updateData).toHaveBeenCalledWith({ ...RESTATEMENT, statusChecks: 1 });
    expect(sink.upload).not.toHaveBeenCalled();
    expect(settleAdsUpload).not.toHaveBeenCalled();
  });

  it("waits longer after each check, an hour at most", async () => {
    getUploadStatus.mockResolvedValue("restating");
    const sink = sinkWithStatus("processing");
    const second = job(0, { ...RESTATEMENT, statusChecks: 1 });
    let before = Date.now();
    await expect(runAdsConversion(second, sink, "token")).rejects.toBeInstanceOf(DelayedError);
    const secondWait = vi.mocked(second.moveToDelayed).mock.calls[0]![0] - before;
    expect(secondWait).toBeGreaterThanOrEqual(39 * MINUTE);
    const late = job(0, { ...RESTATEMENT, statusChecks: 9 });
    before = Date.now();
    await expect(runAdsConversion(late, sink, "token")).rejects.toBeInstanceOf(DelayedError);
    const lateWait = vi.mocked(late.moveToDelayed).mock.calls[0]![0] - before;
    expect(lateWait).toBeGreaterThanOrEqual(60 * MINUTE);
    expect(lateWait).toBeLessThan(67 * MINUTE);
  });

  it("gives the restatement up when Google is still processing the original a day later", async () => {
    getUploadStatus.mockResolvedValue("restating");
    const sink = sinkWithStatus("processing");
    const queued = job(0, RESTATEMENT, 24 * 60 * MINUTE + 1);
    await expect(runAdsConversion(queued, sink, "token")).rejects.toBeInstanceOf(UnrecoverableError);
    expect(queued.moveToDelayed).not.toHaveBeenCalled();
    expect(settleAdsUpload).toHaveBeenCalledWith(RESTATEMENT, false);
  });

  it("drops the restatement when Google rejected the original upload", async () => {
    getUploadStatus.mockResolvedValue("restating");
    const sink = sinkWithStatus("failed");
    await expect(runAdsConversion(job(0, RESTATEMENT), sink)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(sink.upload).not.toHaveBeenCalled();
    expect(settleAdsUpload).toHaveBeenCalledWith(RESTATEMENT, false);
  });

  it.each([
    ["conversion", "failed", DATA],
    ["conversion", "uploaded", DATA],
    ["restatement", "restate_failed", RESTATEMENT],
  ] as const)("does not upload a %s whose upload already settled as %s", async (_kind, status, data) => {
    getUploadStatus.mockResolvedValue(status);
    const sink = sinkWithStatus("success");
    await runAdsConversion(job(0, data), sink, "token");
    expect(sink.upload).not.toHaveBeenCalled();
    expect(sink.status).not.toHaveBeenCalled();
    expect(settleAdsUpload).not.toHaveBeenCalled();
  });

  it("re-queues uploads whose job was lost on the sweep job", async () => {
    const sink: AdsConversionSink = { upload: vi.fn(), status: vi.fn() };
    await runAdsConversion({ name: "sweep", data: { kind: "sweep" } } as unknown as Job<AdsConversionJob>, sink);
    expect(requeueStaleAdsUploads).toHaveBeenCalled();
    expect(sink.upload).not.toHaveBeenCalled();
  });

  it("leaves a passing failure to the retries without recording it", async () => {
    const sink: AdsConversionSink = { upload: vi.fn(async () => Promise.reject(Object.assign(new Error("busy"), { code: 14 }))), status: vi.fn() };
    await expect(runAdsConversion(job(0), sink)).rejects.toThrow("busy");
    expect(settleAdsUpload).not.toHaveBeenCalled();
  });

  it("records the failure on the last attempt", async () => {
    const sink: AdsConversionSink = { upload: vi.fn(async () => Promise.reject(Object.assign(new Error("busy"), { code: 14 }))), status: vi.fn() };
    await expect(runAdsConversion(job(4), sink)).rejects.toThrow("busy");
    expect(settleAdsUpload).toHaveBeenCalledWith(DATA, false);
  });

  it("stops at once when the platform refuses the request", async () => {
    const sink: AdsConversionSink = { upload: vi.fn(async () => Promise.reject(Object.assign(new Error("bad"), { code: 3 }))), status: vi.fn() };
    await expect(runAdsConversion(job(0), sink)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(settleAdsUpload).toHaveBeenCalledWith(DATA, false);
  });

  it("stops at once when the conversion is no longer configured", async () => {
    adsConversionConfig.mockReturnValue(null);
    const sink: AdsConversionSink = { upload: vi.fn(), status: vi.fn() };
    await expect(runAdsConversion(job(), sink)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(sink.upload).not.toHaveBeenCalled();
    expect(settleAdsUpload).toHaveBeenCalledWith(DATA, false);
  });
});

describe("googleDataManagerSink", () => {
  it("sends the event to the conversion action with the click, value and measurement-only consent", async () => {
    expect(await googleDataManagerSink(CONFIG).upload(DATA, "22")).toBe("req-1");
    const account = { accountType: "GOOGLE_ADS", accountId: "1234567890" };
    expect(ingestEvents).toHaveBeenCalledWith({
      destinations: [{ operatingAccount: account, loginAccount: account, productDestinationId: "22" }],
      consent: { adUserData: "CONSENT_GRANTED", adPersonalization: "CONSENT_DENIED" },
      events: [
        {
          transactionId: "purchase:cs_1",
          eventTimestamp: { seconds: Date.parse(DATA.occurredAt) / 1000 },
          eventSource: "WEB",
          adIdentifiers: { gclid: "click-1", gbraid: undefined, wbraid: undefined },
          conversionValue: 19.99,
          currency: "USD",
        },
      ],
    });
  });

  it("sends no value for a conversion without one", async () => {
    await googleDataManagerSink(CONFIG).upload({ ...DATA, value: undefined }, "22");
    const [request] = ingestEvents.mock.calls[0] as unknown as [{ events: Record<string, unknown>[] }];
    expect(request.events[0]).not.toHaveProperty("conversionValue");
  });
});

describe("googleDataManagerSink status", () => {
  it.each([
    ["SUCCESS", "success"],
    ["PARTIAL_SUCCESS", "success"],
    ["PROCESSING", "processing"],
    ["REQUEST_STATUS_UNKNOWN", "processing"],
    ["FAILED", "failed"],
  ] as const)("reads %s as %s", async (requestStatus, expected) => {
    retrieveRequestStatus.mockResolvedValueOnce([{ requestStatusPerDestination: [{ requestStatus }] }]);
    expect(await googleDataManagerSink(CONFIG).status("req-0")).toBe(expected);
    expect(retrieveRequestStatus).toHaveBeenCalledWith({ requestId: "req-0" });
  });
});
