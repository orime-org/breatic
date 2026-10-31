// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A queued ad conversion. The handler uploads it, records how it ended, and
 * leaves a failure the platform might recover from to the queue's retries.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnrecoverableError, type Job } from "bullmq";

import type * as CoreModule from "@breatic/core";

const settleAdsUpload = vi.hoisted(() => vi.fn(async () => undefined));
const settleAdsRefused = vi.hoisted(() => vi.fn(async () => undefined));
const adsAllowedFor = vi.hoisted(() => vi.fn(async () => true));
const requeueStaleAdsUploads = vi.hoisted(() => vi.fn(async () => 0));
const adsConversionConfig = vi.hoisted(() => vi.fn());
const getUploadStatus = vi.hoisted(() => vi.fn(async (): Promise<string | null> => "queued"));
const ingestEvents = vi.hoisted(() => vi.fn(async () => [{ requestId: "req-1" }]));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    settleAdsUpload,
    settleAdsRefused,
    adsAllowedFor,
    adsConversionConfig,
    requeueStaleAdsUploads,
    getUploadStatus,
  };
});
vi.mock("@google-ads/datamanager", () => ({
  IngestionServiceClient: class {
    ingestEvents = ingestEvents;
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
  userId: "11111111-1111-4111-8111-111111111111",
  browser: { consent: true },
  conversion: "credit_purchase",
  transactionId: "purchase:cs_1",
  occurredAt: "2026-10-12T01:00:00.000Z",
  click: { gclid: "click-1", at: "2026-10-11T01:00:00.000Z" },
  value: { amountCents: 1999, currency: "usd" },
};

/**
 * A queued job on the given attempt.
 * @param attemptsMade - Attempts already made.
 * @param data - The upload.
 * @returns The job.
 */
function job(attemptsMade = 0, data: AdsConversionJob = DATA): Job<AdsConversionJob> {
  return { name: "conversion", data, attemptsMade, opts: { attempts: 5 } } as unknown as Job<AdsConversionJob>;
}

/**
 * A sink whose upload succeeds.
 * @returns The sink.
 */
function okSink(): AdsConversionSink {
  return { upload: vi.fn(async () => "req-1") };
}

beforeEach(() => {
  vi.clearAllMocks();
  adsConversionConfig.mockReturnValue(CONFIG);
  getUploadStatus.mockImplementation(async () => "queued");
  adsAllowedFor.mockResolvedValue(true);
});

describe("runAdsConversion", () => {
  it("uploads and records the upload", async () => {
    const sink = okSink();
    await runAdsConversion(job(), () => sink);
    expect(sink.upload).toHaveBeenCalledWith(DATA, "22");
    expect(settleAdsUpload).toHaveBeenCalledWith(DATA, true, "req-1");
  });

  it.each(["failed", "uploaded", null])("does not upload a conversion whose row stands at %s", async (status) => {
    getUploadStatus.mockResolvedValue(status);
    const sink = okSink();
    await runAdsConversion(job(), () => sink);
    expect(sink.upload).not.toHaveBeenCalled();
    expect(settleAdsUpload).not.toHaveBeenCalled();
  });

  it("leaves a failed status lookup to the retries, and records the failure on the last attempt", async () => {
    getUploadStatus.mockRejectedValue(new Error("db down"));
    const sink: AdsConversionSink = { upload: vi.fn() };
    await expect(runAdsConversion(job(0), () => sink)).rejects.toThrow("db down");
    expect(settleAdsUpload).not.toHaveBeenCalled();
    await expect(runAdsConversion(job(4), () => sink)).rejects.toThrow("db down");
    expect(settleAdsUpload).toHaveBeenCalledWith(DATA, false);
    expect(sink.upload).not.toHaveBeenCalled();
  });

  it("builds the sink only for a configured conversion", async () => {
    const sink = okSink();
    const makeSink = vi.fn(() => sink);
    await runAdsConversion(job(), makeSink);
    expect(makeSink).toHaveBeenCalledTimes(1);
    expect(sink.upload).toHaveBeenCalledWith(DATA, "22");
    adsConversionConfig.mockReturnValue(null);
    makeSink.mockClear();
    await expect(runAdsConversion(job(), makeSink)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(makeSink).not.toHaveBeenCalled();
  });

  it("re-queues uploads whose job was lost on the sweep job", async () => {
    const sink: AdsConversionSink = { upload: vi.fn() };
    await runAdsConversion({ name: "sweep", data: { kind: "sweep" } } as unknown as Job<AdsConversionJob>, () => sink);
    expect(requeueStaleAdsUploads).toHaveBeenCalled();
    expect(sink.upload).not.toHaveBeenCalled();
  });

  it("leaves a passing failure to the retries without recording it", async () => {
    const sink: AdsConversionSink = { upload: vi.fn(async () => Promise.reject(Object.assign(new Error("busy"), { code: 14 }))) };
    await expect(runAdsConversion(job(0), () => sink)).rejects.toThrow("busy");
    expect(settleAdsUpload).not.toHaveBeenCalled();
  });

  it("records the failure on the last attempt", async () => {
    const sink: AdsConversionSink = { upload: vi.fn(async () => Promise.reject(Object.assign(new Error("busy"), { code: 14 }))) };
    await expect(runAdsConversion(job(4), () => sink)).rejects.toThrow("busy");
    expect(settleAdsUpload).toHaveBeenCalledWith(DATA, false);
  });

  it("stops at once when the platform refuses the request", async () => {
    const sink: AdsConversionSink = { upload: vi.fn(async () => Promise.reject(Object.assign(new Error("bad"), { code: 3 }))) };
    await expect(runAdsConversion(job(0), () => sink)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(settleAdsUpload).toHaveBeenCalledWith(DATA, false);
  });

  it("uploads nothing and records consent_withdrawn when ads are no longer allowed", async () => {
    adsAllowedFor.mockResolvedValue(false);
    const sink: AdsConversionSink = { upload: vi.fn() };
    await runAdsConversion(job(), () => sink);
    expect(adsAllowedFor).toHaveBeenCalledWith(DATA.userId, DATA.browser);
    expect(sink.upload).not.toHaveBeenCalled();
    expect(settleAdsRefused).toHaveBeenCalledWith(DATA);
    expect(settleAdsUpload).not.toHaveBeenCalled();
  });

  it("stops at once on a job whose data does not parse", async () => {
    const sink: AdsConversionSink = { upload: vi.fn() };
    const broken = { ...DATA, userId: undefined } as unknown as AdsConversionJob;
    await expect(runAdsConversion(job(0, broken), () => sink)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(sink.upload).not.toHaveBeenCalled();
    expect(settleAdsUpload).toHaveBeenCalledWith(broken, false);
  });

  it("stops at once when the conversion is no longer configured", async () => {
    adsConversionConfig.mockReturnValue(null);
    const sink: AdsConversionSink = { upload: vi.fn() };
    await expect(runAdsConversion(job(), () => sink)).rejects.toBeInstanceOf(UnrecoverableError);
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
