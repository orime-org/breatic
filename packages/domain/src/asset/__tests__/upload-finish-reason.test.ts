// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * T33 (inner#1595): the reason a finish the Worker did not complete is
 * settled with.
 *
 * The bytes of a browser upload came off a disk the person picked from, so
 * nothing answering reads "aborted", never the no-answer sentinel the server
 * and the link lanes use. Sharing one reason function across those callers
 * must not change that.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as sharedModule from "@breatic/shared";
import type * as ingestReportModule from "@domain/asset/ingest-report.service.js";

const KEY = "image/2026-10-26/1_00000000-0000-4000-8000-000000000001.png";
const DEADLINE_AT = Date.now() + 7_200_000;

const finishUploadAtIngest = vi.hoisted(() => vi.fn());
const applyIngestReport = vi.hoisted(() => vi.fn());

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
vi.mock("@domain/asset/ingest-report.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ingestReportModule>()),
  applyIngestReport,
}));

const { finishUpload } = await import("@domain/asset/upload-finish.service.js");
const { INGEST_REFUSED_UNNAMED, UploadHttpError } = await import("@breatic/shared");

beforeEach(() => {
  finishUploadAtIngest.mockReset();
  applyIngestReport.mockReset().mockResolvedValue({ status: "voided" });
});

describe("T33 finishUpload settles a finish that did not complete", () => {
  it.each([
    ["nothing answered", () => new TypeError("fetch failed"), "aborted"],
    ["the Worker refused unnamed", () => new UploadHttpError(502, null), INGEST_REFUSED_UNNAMED],
    ["the Worker named its refusal", () => new UploadHttpError(502, "assemble_failed"), "assemble_failed"],
  ])("when %s", async (_label, make, reason) => {
    finishUploadAtIngest.mockRejectedValue(make());

    const result = await finishUpload({
      storageKey: KEY,
      uploadId: "upload-1",
      token: "token-1",
      parts: [{ partNumber: 1, etag: "etag-1" }],
      assetSource: null,
    });

    expect(applyIngestReport).toHaveBeenCalledExactlyOnceWith({
      storageKey: KEY,
      outcome: "aborted",
      reason,
    });
    expect(result.refused?.reason).toBe(reason);
  });
});
