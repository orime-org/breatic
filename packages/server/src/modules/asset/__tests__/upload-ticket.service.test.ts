// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The transfer branch of `issueUploadTicket` (inner#1006 design §4.2, test
 * spec T28).
 *
 * A transfer file never becomes an asset and never counts toward storage, so
 * the branch asks neither the dedup ledger nor the storage allowance; the key,
 * the grant's provenance, the file name and the signed type are all the
 * server's, not the browser's.
 *
 * The call shape is an assumption of this test: the design says only that
 * `issueUploadTicket` gains a transfer branch. It is reached here the way the
 * existing purposes are, through `purpose`, with nothing but the size the
 * browser sends.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRANSFER_MEDIA_TYPE } from "@breatic/shared";

const TRANSFER_TYPE = "application/vnd.breatic.transfer";

const checkUploadDedup = vi.fn(async () => null);
const settleDedupHit = vi.fn(async () => {});
const openUpload = vi.fn(async () => ({
  key: "transfer/2026-10-24/1_00000000-0000-4000-8000-000000000000.transfer",
  studioId: "studio-1",
  taskId: undefined,
}));
const signTicketFor = vi.fn(async () => ({
  ticket: "signed-ticket",
  uploadUrl: "https://ingest.test.invalid",
  partSize: 8388608,
  totalParts: 1,
}));

vi.mock("@breatic/core", () => ({
  AppError: class AppError extends Error {},
  env: { INGEST_SHARED_SECRET: "secret", INGEST_BASE_URL: "https://ingest.test.invalid" },
  getNodeTaskConfig: () => ({ default_budget_ms: 7_200_000 }),
  getStorageConfig: () => ({
    upload: { max_upload_bytes: 2147483648 },
    ingest: { ticket_expires_seconds: 300, part_size_bytes: 8388608 },
    transfer: {
      route_max_bytes: { chat_message: 4194304, canvas_paste: 25165824, node_history_snapshot: 25165824 },
      reference_ttl_seconds: 3600,
      read_lock_seconds: 60,
    },
  }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@breatic/domain", () => ({
  assetService: {
    detectAssetKind: (contentType: string) => (contentType.startsWith("image/") ? "image" : "file"),
  },
  safeExt: (filename: string) => filename.slice(filename.lastIndexOf(".")),
  uploadDeadlineByKey: async () => 1_900_000_000_000,
  uploadTicketService: { signTicketFor },
}));

vi.mock("@server/modules/asset/assetUpload.service.js", () => ({ checkUploadDedup, settleDedupHit }));
vi.mock("@server/modules/asset/storageQuota.service.js", () => ({
  INSUFFICIENT_STORAGE: 507,
  assertStudioStorageAllowance: vi.fn(async () => {}),
}));
vi.mock("@server/modules/asset/upload-opening.js", () => ({ openUpload }));

const { issueUploadTicket } = await import("@server/modules/asset/upload-ticket.service.js");

const SCOPE = {
  userId: "22222222-2222-4222-8222-222222222222",
  studioId: "studio-1",
  projectId: "11111111-1111-4111-8111-111111111111",
};

/** The transfer request as the route hands it over: a purpose and a size. */
const TRANSFER_ITEM = { purpose: "transfer", size: 1500019 } as unknown as Parameters<
  typeof issueUploadTicket
>[1];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("T28: the transfer branch of issueUploadTicket", () => {
  it("names the shared transfer type", () => {
    expect(TRANSFER_MEDIA_TYPE).toBe(TRANSFER_TYPE);
  });

  it("asks neither dedup nor the storage allowance", async () => {
    const admitStorage = vi.fn(async () => true);

    // Settled either way: what is asserted is which questions were asked.
    await issueUploadTicket(SCOPE, TRANSFER_ITEM, admitStorage).catch(() => undefined);

    expect(checkUploadDedup).toHaveBeenCalledTimes(0);
    expect(admitStorage).toHaveBeenCalledTimes(0);
  });

  it("opens a transfer grant with no node and no space, under a .transfer key", async () => {
    await issueUploadTicket(SCOPE, TRANSFER_ITEM, vi.fn(async () => true));

    expect(openUpload).toHaveBeenCalledTimes(1);
    const [grant] = openUpload.mock.calls[0] as unknown as [
      { taskType: string; ext: string; declaredSize: number; context: Record<string, unknown> },
    ];
    expect(grant.taskType).toBe("transfer");
    expect(grant.ext).toBe(".transfer");
    expect(grant.declaredSize).toBe(1500019);
    expect(grant.context).toMatchObject({
      assetSource: "transfer",
      derived: true,
      nodeId: null,
      spaceId: null,
      filename: "body.transfer",
    });
  });

  it("signs the ticket with the transfer type", async () => {
    await issueUploadTicket(SCOPE, TRANSFER_ITEM, vi.fn(async () => true));

    expect(signTicketFor).toHaveBeenCalledTimes(1);
    const [signed] = signTicketFor.mock.calls[0] as unknown as [{ contentType: string; declaredSize: number }];
    expect(signed.contentType).toBe(TRANSFER_TYPE);
    expect(signed.declaredSize).toBe(1500019);
  });
});
