// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Lane ③ into a derived key (inner#1306 test plan §97 D21-1; frames-split §7.17, the paragraph after the recipe table).
 *
 * A lip-sync step's provider result (SAM3's `rle_url`, the generation's video URL) is only a temporary link, so the
 * ingest Worker fetches it, as `transferUrlToStorage` does, but into the derived key the caller names
 * (`${stepKey}:${attemptId}`) and with no `studio_assets` row: `backendUploadService.transferUrlToDerived(sourceUrl,
 * { storageKey, contentType, projectId, actingUserId, deadlineAt })` answers the Worker's report on the stored bytes as
 * `{ storageKey, sha256, size, contentType }`, and the caller records it with the step result and the execution pin.
 *
 * The grant, the owner studio, the ticket and the Worker fetch are mocked as in backend-upload.service.test.ts; the function
 * is read by name so this file compiles before it exists. That no asset row and no storage usage come of it (DV02, DV04)
 * is read from the database in backend-upload-derived.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as sharedModule from "@breatic/shared";
import type * as coreModule from "@breatic/core";

const issueUploadGrant = vi.fn();
const signUploadTicket = vi.fn();
const fetchUrlToIngest = vi.fn();
const applyIngestReport = vi.fn();

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof coreModule>()),
  env: { INGEST_SHARED_SECRET: "secret", INGEST_BASE_URL: "https://ingest.example" },
  getStorageConfig: () => ({
    ingest: { part_size_bytes: 8 * 1024 * 1024, ticket_expires_seconds: 900, upright_jpeg_quality: 85 },
    upload: { max_upload_bytes: 2 * 1024 * 1024 * 1024, client_max_attempts: 3, client_retry_base_delay_ms: 500, upload_idle_timeout_seconds: 45 },
  }),
}));
vi.mock("@breatic/shared", async (importOriginal) => ({ ...(await importOriginal<typeof sharedModule>()), signUploadTicket, fetchUrlToIngest }));
vi.mock("@domain/asset/upload-grant.service.js", () => ({ issueUploadGrant }));
// The ticket names the project's owner studio, which the asset service reads from the database (§97 D23-1).
const resolveOwnerStudioId = vi.fn();
vi.mock("@domain/asset/asset.service.js", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), resolveOwnerStudioId }));
vi.mock("@domain/asset/ingest-report.service.js", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), applyIngestReport }));

type Derived = (sourceUrl: string, target: { storageKey: string; contentType: string; projectId: string; actingUserId: string; deadlineAt: number }) =>
  Promise<{ storageKey: string; sha256: string; size: number; contentType: string }>;
const service = await import("@domain/asset/backend-upload.service.js") as unknown as { transferUrlToDerived?: Derived };
const { UploadHttpError } = await import("@breatic/shared");

const KEY = `${"7".repeat(64)}:5b0c2f0e-4a7d-4f1e-9d39-2a7e1c6d8f10`;
const RLE_URL = "https://provider.example.test/sam3/person-1.rle.json";
const MEASURED = { sha256: "a".repeat(64), sizeBytes: 4096, contentType: "application/json" };
const TARGET = { storageKey: KEY, contentType: "application/json", projectId: "10000000-0000-4000-8000-000000000001", actingUserId: "60000000-0000-4000-8000-000000000001", deadlineAt: Date.now() + 3_600_000 };

/**
 * The function under test, failing clearly while it does not exist.
 * @returns It.
 */
function derived(): Derived {
  expect(service.transferUrlToDerived, "backendUploadService.transferUrlToDerived exists").toBeTypeOf("function");
  return service.transferUrlToDerived!;
}

beforeEach(() => {
  vi.clearAllMocks();
  issueUploadGrant.mockResolvedValue({ key: KEY, studioId: "s1" });
  resolveOwnerStudioId.mockResolvedValue("s1");
  signUploadTicket.mockResolvedValue("signed-ticket");
  fetchUrlToIngest.mockResolvedValue(MEASURED);
  // A finish that writes no row answers as a transfer finish does (ingest-report.service.ts, inner#1006).
  applyIngestReport.mockResolvedValue({ status: "transferred" });
});

describe("transferUrlToDerived: a provider link into a named derived key (§97 D21-1)", () => {
  it("DV01 hands the Worker the link under a ticket for exactly the named key and type, and answers the Worker's report", async () => {
    const answer = await derived()(RLE_URL, TARGET);
    expect(signUploadTicket).toHaveBeenCalledTimes(1);
    expect(signUploadTicket.mock.calls[0]?.[0]).toMatchObject({ storageKey: KEY, contentType: "application/json", studioId: "s1", userId: TARGET.actingUserId });
    // The bytes never reach this process: the Worker is handed the link, as lane ③ does.
    expect(fetchUrlToIngest).toHaveBeenCalledTimes(1);
    expect(fetchUrlToIngest.mock.calls[0]?.[0]).toBe(RLE_URL);
    expect(fetchUrlToIngest.mock.calls[0]?.[1]).toMatchObject({ ticket: "signed-ticket" });
    expect(fetchUrlToIngest.mock.calls[0]?.[2]).toBe("secret");
    // §97 D22-2: the fetch is bounded by the task's own deadline (root AGENTS.md, Task time limit).
    expect(fetchUrlToIngest.mock.calls[0]?.[3]).toMatchObject({ deadlineAt: TARGET.deadlineAt });
    // Hash, size and type come from the Worker's report on the stored bytes, never from the caller.
    expect(answer).toEqual({ storageKey: KEY, sha256: MEASURED.sha256, size: MEASURED.sizeBytes, contentType: MEASURED.contentType });
  });

  it("DV03 a Worker refusal reaches the caller", async () => {
    const refused = new UploadHttpError(502, "source_unreachable");
    fetchUrlToIngest.mockRejectedValue(refused);
    await expect(derived()(RLE_URL, TARGET)).rejects.toBe(refused);
  });
});
