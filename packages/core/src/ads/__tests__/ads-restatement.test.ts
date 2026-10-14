// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdsConversionJob, AdsUploadStatus } from "@core/ads/ads-types.js";

const row = vi.hoisted((): { status: AdsUploadStatus } => ({ status: "queued" }));
const repo = vi.hoisted(() => ({
  findUploadByPayment: vi.fn(),
  moveUpload: vi.fn(),
  getUploadStatus: vi.fn(async () => row.status),
  claimUpload: vi.fn(),
  findStaleUploads: vi.fn(),
}));
const queue = vi.hoisted(() => ({ add: vi.fn(async () => undefined) }));

vi.mock("@core/ads/ads-conversion.repo.js", () => repo);
vi.mock("@core/analytics/account.repo.js", () => ({ adsAllowedFor: vi.fn(async () => true) }));
vi.mock("@core/infra/queue.js", () => ({ createQueue: () => queue, defaultJobOpts: () => ({}) }));

import { enqueueAdsRestatement, setAdsConversionConfigForTest } from "@core/ads/ads-conversion.js";

const JOB: AdsConversionJob = {
  kind: "conversion",
  userId: "11111111-1111-4111-8111-111111111111",
  browser: null,
  conversion: "credit_purchase",
  transactionId: "purchase:cs_1",
  occurredAt: "2026-10-14T00:00:00.000Z",
  click: { gclid: "g", at: "2026-10-14T00:00:00.000Z" },
  value: { amountCents: 1000, currency: "usd" },
};

beforeEach(() => {
  vi.clearAllMocks();
  setAdsConversionConfigForTest({ customerId: "1234567890", actions: { credit_purchase: "1" }, credentials: { client_email: "a", private_key: "b" } });
  // The row moves from queued to uploaded between the refund's read and its first move.
  row.status = "queued";
  repo.findUploadByPayment.mockImplementation(async () => {
    const read = { status: row.status, job: JOB, requestId: "req-1" };
    row.status = "uploaded";
    return read;
  });
  repo.moveUpload.mockImplementation(async (_key: unknown, from: AdsUploadStatus[], to: AdsUploadStatus) => {
    if (!from.includes(row.status)) return false;
    row.status = to;
    return true;
  });
});

describe("enqueueAdsRestatement", () => {
  it("restates a conversion whose upload landed while the refund was being read", async () => {
    expect(await enqueueAdsRestatement("payment-1")).toBe("queued");
    expect(row.status).toBe("restating");
    expect(queue.add).toHaveBeenCalledWith("restatement", expect.objectContaining({ kind: "restatement" }), expect.anything());
  });
});
