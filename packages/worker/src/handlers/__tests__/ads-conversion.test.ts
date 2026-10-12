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
const adsConversionConfig = vi.hoisted(() => vi.fn());
const ingestEvents = vi.hoisted(() => vi.fn(async () => [{}]));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return { ...actual, settleAdsUpload, adsConversionConfig };
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
function job(attemptsMade = 0): Job<AdsConversionJob> {
  return { data: DATA, attemptsMade, opts: { attempts: 5 } } as Job<AdsConversionJob>;
}

beforeEach(() => {
  vi.clearAllMocks();
  adsConversionConfig.mockReturnValue(CONFIG);
});

describe("runAdsConversion", () => {
  it("uploads and records the upload", async () => {
    const sink: AdsConversionSink = { upload: vi.fn(async () => undefined) };
    await runAdsConversion(job(), sink);
    expect(sink.upload).toHaveBeenCalledWith(DATA, "22");
    expect(settleAdsUpload).toHaveBeenCalledWith(DATA, true);
  });

  it("leaves a passing failure to the retries without recording it", async () => {
    const sink: AdsConversionSink = { upload: vi.fn(async () => Promise.reject(Object.assign(new Error("busy"), { code: 14 }))) };
    await expect(runAdsConversion(job(0), sink)).rejects.toThrow("busy");
    expect(settleAdsUpload).not.toHaveBeenCalled();
  });

  it("records the failure on the last attempt", async () => {
    const sink: AdsConversionSink = { upload: vi.fn(async () => Promise.reject(Object.assign(new Error("busy"), { code: 14 }))) };
    await expect(runAdsConversion(job(4), sink)).rejects.toThrow("busy");
    expect(settleAdsUpload).toHaveBeenCalledWith(DATA, false);
  });

  it("stops at once when the platform refuses the request", async () => {
    const sink: AdsConversionSink = { upload: vi.fn(async () => Promise.reject(Object.assign(new Error("bad"), { code: 3 }))) };
    await expect(runAdsConversion(job(0), sink)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(settleAdsUpload).toHaveBeenCalledWith(DATA, false);
  });

  it("stops at once when the conversion is no longer configured", async () => {
    adsConversionConfig.mockReturnValue(null);
    const sink: AdsConversionSink = { upload: vi.fn() };
    await expect(runAdsConversion(job(), sink)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(sink.upload).not.toHaveBeenCalled();
    expect(settleAdsUpload).toHaveBeenCalledWith(DATA, false);
  });
});

describe("googleDataManagerSink", () => {
  it("sends the event to the conversion action with the click, value and granted consent", async () => {
    await googleDataManagerSink(CONFIG).upload(DATA, "22");
    const account = { accountType: "GOOGLE_ADS", accountId: "1234567890" };
    expect(ingestEvents).toHaveBeenCalledWith({
      destinations: [{ operatingAccount: account, loginAccount: account, productDestinationId: "22" }],
      consent: { adUserData: "CONSENT_GRANTED", adPersonalization: "CONSENT_GRANTED" },
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
