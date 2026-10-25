// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * T34 (inner#1006 §4.3): finishing a transfer upload branches off before
 * `storedTypeAccepted`. It asks the Worker with `deferMediaRead: true` passed
 * straight in, never consults `readsMediaAtFinish`, and neither registers an
 * asset (`applyIngestReport`) nor schedules a media read. An ordinary upload
 * (`assetSource: null`) still asks `readsMediaAtFinish` exactly once.
 *
 * The Worker, the grant ledger and the deadline lookup are stood in; what is
 * pinned is which steps the transfer branch takes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as sharedModule from "@breatic/shared";
import type * as mediaReadModule from "@domain/asset/media-read.service.js";
import type * as ingestReportModule from "@domain/asset/ingest-report.service.js";
import type * as grantRepoModule from "@domain/asset/upload-grant.repo.js";
import type { UploadFinishJob } from "@domain/asset/upload-finish.service.js";

const TMT = "application/vnd.breatic.transfer";
const KEY = "transfer/2026-10-24/1_00000000-0000-4000-8000-000000000001.transfer";
const DEADLINE_AT = Date.now() + 7_200_000;

const finishUploadAtIngest = vi.hoisted(() => vi.fn());
const readsMediaAtFinish = vi.hoisted(() => vi.fn());
const storedTypeAccepted = vi.hoisted(() => vi.fn());
const scheduleMediaRead = vi.hoisted(() => vi.fn(async () => undefined));
const applyIngestReport = vi.hoisted(() => vi.fn());
const completeTransferGrant = vi.hoisted(() => vi.fn(async () => true));
const findGrantByKey = vi.hoisted(() => vi.fn());

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  env: { INGEST_SHARED_SECRET: "secret", INGEST_BASE_URL: "https://ingest.example" },
}));
vi.mock("@breatic/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof sharedModule>()),
  finishUploadAtIngest,
}));
vi.mock("@domain/asset/upload-deadline.js", () => ({
  uploadDeadlineByKey: vi.fn(async () => DEADLINE_AT),
}));
vi.mock("@domain/asset/upload-grant.repo.js", async (importOriginal) => ({
  ...(await importOriginal<typeof grantRepoModule>()),
  findGrantByKey,
  completeTransferGrant,
}));
vi.mock("@domain/asset/media-read.service.js", async (importOriginal) => {
  const real = await importOriginal<typeof mediaReadModule>();
  readsMediaAtFinish.mockImplementation(real.readsMediaAtFinish);
  storedTypeAccepted.mockImplementation(real.storedTypeAccepted);
  return { ...real, readsMediaAtFinish, storedTypeAccepted, scheduleMediaRead };
});
vi.mock("@domain/asset/ingest-report.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ingestReportModule>()),
  applyIngestReport,
}));

const { finishUpload } = await import("@domain/asset/upload-finish.service.js");
const { ingestRunFor } = await import("@domain/asset/asset.service.js");
const realMediaRead = await import("@domain/asset/media-read.service.js");

/**
 * The grant row the ledger holds for a key.
 * @param assetSource - What the grant says the upload is.
 * @returns The grant, finishing, declared at 1500019 bytes.
 */
function grantFor(assetSource: string | null): Record<string, unknown> {
  return {
    id: "grant-1",
    userId: "user-a",
    studioId: "studio-1",
    storageKey: KEY,
    declaredSize: 1_500_019,
    consumedAt: null,
    voidedAt: null,
    assetId: null,
    failureReason: null,
    expiresAt: new Date(DEADLINE_AT),
    nodeId: null,
    projectId: "project-1",
    spaceId: null,
    source: null,
    toolName: null,
    derived: true,
    filename: "body.transfer",
    assetSource,
    generationTaskId: null,
    analyticsConsent: null,
    createdAt: new Date(),
  };
}

beforeEach(() => {
  finishUploadAtIngest.mockReset();
  readsMediaAtFinish.mockClear();
  storedTypeAccepted.mockClear();
  scheduleMediaRead.mockClear();
  applyIngestReport.mockReset();
  completeTransferGrant.mockClear();
  findGrantByKey.mockReset();
});

describe("T34 the transfer branch of finishUpload", () => {
  it("skips the media and registration steps and asks the Worker with deferMediaRead true", async () => {
    findGrantByKey.mockResolvedValue(grantFor("transfer"));
    finishUploadAtIngest.mockResolvedValue({ contentType: TMT, sizeBytes: 100, sha256: "a".repeat(64) });

    await finishUpload({
      storageKey: KEY,
      uploadId: "upload-1",
      token: "token-1",
      parts: [{ partNumber: 1, etag: "etag-1" }],
      assetSource: "transfer" as UploadFinishJob["assetSource"],
    });

    expect(readsMediaAtFinish).toHaveBeenCalledTimes(0);
    expect(storedTypeAccepted).toHaveBeenCalledTimes(0);
    expect(scheduleMediaRead).toHaveBeenCalledTimes(0);
    expect(applyIngestReport).toHaveBeenCalledTimes(0);
    expect(finishUploadAtIngest).toHaveBeenCalledTimes(1);
    const run = finishUploadAtIngest.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(run.deferMediaRead).toBe(true);
    const expectedRun = ingestRunFor(KEY, DEADLINE_AT);
    expect(run.coverKey).toBe(expectedRun.coverKey);
    expect(run.deadlineAt).toBe(DEADLINE_AT);
    expect(run.limits).toEqual(expectedRun.limits);
  });

  it("still asks readsMediaAtFinish exactly once for an ordinary upload", async () => {
    findGrantByKey.mockResolvedValue(grantFor(null));
    finishUploadAtIngest.mockResolvedValue({
      contentType: "image/png",
      sizeBytes: 100,
      sha256: "a".repeat(64),
    });
    applyIngestReport.mockResolvedValue({ status: "already_registered" });

    await finishUpload({
      storageKey: "image/2026-10-24/1_a.png",
      uploadId: "upload-2",
      token: "token-2",
      parts: [{ partNumber: 1, etag: "etag-1" }],
      assetSource: null,
    });

    expect(readsMediaAtFinish).toHaveBeenCalledTimes(1);
    expect(readsMediaAtFinish).toHaveBeenCalledWith(null);
  });

  it("does not let readsMediaAtFinish take transfer", () => {
    // @ts-expect-error -- the parameter is StudioAssetEntity["source"] | null, which never holds "transfer".
    expect(realMediaRead.readsMediaAtFinish("transfer")).toBe(true);
  });
});
