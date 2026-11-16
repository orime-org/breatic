// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The server's upload tickets: `issueTransferTicket` (inner#1006 design
 * §4.2, test spec T28) and, since inner#1595, the server opening every upload
 * at the ingest Worker itself before it answers (test spec §5, T50–T59, T78,
 * T79).
 *
 * A transfer file never becomes an asset and never counts toward storage, so
 * the ticket asks neither the dedup ledger nor the storage allowance; the key,
 * the grant's provenance, the file name and the signed type are all the
 * server's, not the browser's.
 *
 * Opening the upload is domain's `openSignedUpload`, mocked here. When it
 * fails it throws `UploadOpenFailed`, which domain exports at its top level;
 * this file mocks domain whole, so a minimal class of that name stands in and
 * is the very reference the code under test checks with `instanceof`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { INGEST_NO_ANSWER, TRANSFER_MEDIA_TYPE } from "@breatic/shared";

const TRANSFER_TYPE = "application/vnd.breatic.transfer";

const h = vi.hoisted(() => {
  /** Domain's typed open failure, as far as the server reads it (test spec T29). */
  class UploadOpenFailed extends Error {
    readonly storageKey: string;
    readonly reason: string;
    readonly settled?: unknown;
    readonly settleError?: unknown;

    /**
     * Build the failure.
     * @param init - The key, the reason, how settling went and the open's own error.
     * @param init.storageKey - The upload's key.
     * @param init.reason - The failure reason.
     * @param init.settled - What settling the grant answered, when it answered.
     * @param init.settleError - What settling threw, when it threw.
     * @param init.cause - The error opening the upload threw.
     */
    constructor(init: {
      storageKey: string;
      reason: string;
      settled?: unknown;
      settleError?: unknown;
      cause: unknown;
    }) {
      super(`upload open failed: ${init.reason}`, { cause: init.cause });
      this.name = "UploadOpenFailed";
      this.storageKey = init.storageKey;
      this.reason = init.reason;
      if ("settled" in init) this.settled = init.settled;
      if ("settleError" in init) this.settleError = init.settleError;
    }
  }
  return {
    UploadOpenFailed,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});
const { UploadOpenFailed, logger } = h;

const K = "image/2026-10-26/1_00000000-0000-4000-8000-000000000000.png";
const UPLOAD_URL = "https://ingest.test.invalid";
const PART = 8388608;
const OK = { uploadUrl: UPLOAD_URL, uploadId: "u-1", token: "t-1", partSize: PART, totalParts: 1 };

const checkUploadDedup = vi.fn();
const settleDedupHit = vi.fn();
const openUpload = vi.fn();
const openSignedUpload = vi.fn();
const uploadDeadlineByKey = vi.fn();
const noteIngestSideEffects = vi.fn();
const assertStudioStorageAllowance = vi.fn();
const openDone = vi.fn();
const publishSpaceTasksQuietly = vi.fn();

vi.mock("@breatic/core", () => ({
  AppError: class AppError extends Error {},
  accountActivityRepo: { recordActivity: vi.fn(async () => undefined) },
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
  logger: h.logger,
}));

vi.mock("@breatic/domain", () => ({
  assetService: {
    detectAssetKind: (contentType: string) => (contentType.startsWith("image/") ? "image" : "file"),
  },
  safeExt: (filename: string) => filename.slice(filename.lastIndexOf(".")),
  uploadDeadlineByKey,
  sceneTaskService: { openDone },
  uploadTicketService: { openSignedUpload },
  UploadOpenFailed: h.UploadOpenFailed,
}));

vi.mock("@server/modules/asset/assetUpload.service.js", () => ({ checkUploadDedup, settleDedupHit }));
vi.mock("@server/modules/asset/storageQuota.service.js", () => ({
  INSUFFICIENT_STORAGE: 507,
  assertStudioStorageAllowance,
}));
vi.mock("@server/modules/asset/upload-opening.js", () => ({ openUpload }));
vi.mock("@server/modules/asset/ingest-side-effects.js", () => ({ noteIngestSideEffects }));
vi.mock("@server/modules/task/publish-counts.js", () => ({ publishSpaceTasksQuietly }));

const { issueTransferTicket, issueUploadTicket } = await import(
  "@server/modules/asset/upload-ticket.service.js"
);

const SCOPE = {
  userId: "22222222-2222-4222-8222-222222222222",
  studioId: "studio-1",
  projectId: "11111111-1111-4111-8111-111111111111",
};

/** The size the browser asks for: the whole transfer file, signature included. */
const SIZE = 1500019;

/** The 3D Space a model is imported into. */
const SCENE_SPACE = "66666666-6666-4666-8666-666666666666";

/** One picture onto one node. */
const ITEM = {
  filename: "photo.png",
  content_type: "image/png",
  size: 4096,
  client_hash: "hash-1",
  node_id: "33333333-3333-4333-8333-333333333333",
  space_id: "44444444-4444-4444-8444-444444444444",
};

/** What settling an aborted grant answered: the grant voided, one side effect lost. */
const S = { status: "voided", countsPublishFailed: true };
/** The error opening the upload threw. */
const C = new Error("open failed at the Worker");
/** The error settling the grant threw. */
const D = new Error("db down");
/** The open failed and settling worked. */
const F = new UploadOpenFailed({ storageKey: K, reason: "store_failed", settled: S, cause: C });
/** The open failed and settling failed too. */
const G = new UploadOpenFailed({ storageKey: K, reason: "store_failed", settleError: D, cause: C });

/**
 * Every `upload_open_failed` line logged so far.
 * @returns Each line's fields.
 */
function openFailedLines(): Record<string, unknown>[] {
  return logger.error.mock.calls
    .filter((call) => call[1] === "upload_open_failed")
    .map((call) => call[0] as Record<string, unknown>);
}

/**
 * The fields of the one info line named `event`.
 * @param event - The log message.
 * @returns Its fields.
 */
function infoLine(event: string): Record<string, unknown> {
  const lines = logger.info.mock.calls.filter((call) => call[1] === event);
  expect(lines).toHaveLength(1);
  return lines[0]![0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  checkUploadDedup.mockReset().mockResolvedValue(null);
  settleDedupHit.mockReset().mockResolvedValue(undefined);
  openUpload.mockReset().mockResolvedValue({ key: K, studioId: "studio-1", taskId: "task-1" });
  openSignedUpload.mockReset().mockResolvedValue(OK);
  uploadDeadlineByKey.mockReset().mockImplementation(async () => Date.now() + 7_200_000);
  noteIngestSideEffects.mockReset();
  assertStudioStorageAllowance.mockReset().mockResolvedValue(undefined);
});

describe("T28: issueTransferTicket", () => {
  it("names the shared transfer type", () => {
    expect(TRANSFER_MEDIA_TYPE).toBe(TRANSFER_TYPE);
  });

  it("asks neither dedup nor the storage allowance", async () => {
    // Settled either way: what is asserted is which questions were asked.
    await issueTransferTicket(SCOPE, SIZE).catch(() => undefined);

    expect(checkUploadDedup).toHaveBeenCalledTimes(0);
    expect(settleDedupHit).toHaveBeenCalledTimes(0);
    expect(assertStudioStorageAllowance).toHaveBeenCalledTimes(0);
  });

  it("opens a transfer grant with no node and no space, under a .transfer key", async () => {
    await issueTransferTicket(SCOPE, SIZE);

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

  // inner#1595 T50: replaces "signs the ticket with the transfer type"; the
  // signed values are the same, read off what the server opens now.
  it("T50: opens the transfer upload once, signed with the transfer type, and answers no ticket", async () => {
    const DL = Date.now() + 3_600_000;
    uploadDeadlineByKey.mockResolvedValue(DL);

    const issued = await issueTransferTicket(SCOPE, SIZE);

    expect(openSignedUpload).toHaveBeenCalledTimes(1);
    // inner#1595 R1: the opener bounds itself by the request's deadline.
    expect(openSignedUpload.mock.calls[0]).toHaveLength(1);
    const [request] = openSignedUpload.mock.calls[0] as [
      { contentType: string; declaredSize: number; storageKey: string; deadlineAt: number },
    ];
    expect(request.contentType).toBe(TRANSFER_TYPE);
    expect(request.declaredSize).toBe(1500019);
    expect(request.storageKey).toBe(K);
    expect(request.deadlineAt).toBe(DL);
    expect(issued).toMatchObject({ kind: "ticket", uploadId: "u-1", token: "t-1", storageKey: K });
    expect(issued).not.toHaveProperty("ticket");
    expect(infoLine("transfer_ticket_issued")).toMatchObject({ uploadId: "u-1" });
  });

  it.each([
    ["settling worked", F, 1],
    ["settling failed too", G, 0],
  ])("T51: rethrows the open failure untouched when %s, logging only its side effects", async (_label, failure, notes) => {
    openSignedUpload.mockRejectedValue(failure);

    const thrown = await issueTransferTicket(SCOPE, SIZE).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(thrown).toBe(failure);
    // The error is logged once, by errorHandler (T75), not here.
    expect(logger.error).toHaveBeenCalledTimes(0);
    expect(noteIngestSideEffects).toHaveBeenCalledTimes(notes);
    if (notes === 1) expect(noteIngestSideEffects).toHaveBeenCalledWith(K, S);
  });
});

describe("inner#1595: issueUploadTicket opens the upload itself", () => {
  it("T52: opens once under the task row's own deadline and answers the upload id and token", async () => {
    const DL = Date.now() + 3_600_000;
    uploadDeadlineByKey.mockResolvedValue(DL);

    const outcome = await issueUploadTicket(SCOPE, ITEM, async () => true);

    expect(openSignedUpload).toHaveBeenCalledTimes(1);
    // inner#1595 R1: the opener bounds itself by the request's deadline.
    expect(openSignedUpload.mock.calls[0]).toHaveLength(1);
    const [request] = openSignedUpload.mock.calls[0] as [
      { deadlineAt: number; storageKey: string; contentType: string },
    ];
    expect(request.deadlineAt).toBe(DL);
    expect(request.storageKey).toBe(K);
    expect(request.contentType).toBe("image/png");
    expect(outcome).toEqual({
      kind: "ticket",
      uploadId: "u-1",
      token: "t-1",
      storageKey: K,
      uploadUrl: UPLOAD_URL,
      assetKind: "image",
      partSize: PART,
      totalParts: 1,
      taskId: "task-1",
    });
    expect(outcome).not.toHaveProperty("ticket");
    expect(infoLine("upload_ticket_issued")).toMatchObject({ uploadId: "u-1" });
  });

  it("T53: answers openFailed with the task id, logs it once and writes down the side effects", async () => {
    openSignedUpload.mockRejectedValue(F);

    const outcome = await issueUploadTicket(SCOPE, ITEM, async () => true);

    expect(outcome).toEqual({ kind: "openFailed", reason: "store_failed", taskId: "task-1" });
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [fields, event] = logger.error.mock.calls[0]!;
    expect(event).toBe("upload_open_failed");
    expect(fields).toEqual({
      err: C,
      settleError: undefined,
      key: K,
      userId: SCOPE.userId,
      projectId: SCOPE.projectId,
      reason: "store_failed",
    });
    expect((fields as { err: unknown }).err).toBe(C);
    expect(noteIngestSideEffects).toHaveBeenCalledTimes(1);
    expect(noteIngestSideEffects).toHaveBeenCalledWith(K, S);
  });

  it("T54: answers openFailed with no task id for an upload with no node", async () => {
    openUpload.mockResolvedValue({ key: K, studioId: "studio-1", taskId: undefined });
    openSignedUpload.mockRejectedValue(
      new UploadOpenFailed({ storageKey: K, reason: INGEST_NO_ANSWER, settled: S, cause: C }),
    );

    const outcome = await issueUploadTicket(SCOPE, ITEM, async () => true);

    expect(outcome).toEqual({ kind: "openFailed", reason: INGEST_NO_ANSWER, taskId: undefined });
  });

  it("T55: still answers openFailed with the task id when settling failed too", async () => {
    openSignedUpload.mockRejectedValue(G);

    const outcome = await issueUploadTicket(SCOPE, ITEM, async () => true);

    expect(outcome).toEqual({ kind: "openFailed", reason: "store_failed", taskId: "task-1" });
    const lines = openFailedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      err: C,
      settleError: D,
      key: K,
      userId: SCOPE.userId,
      projectId: SCOPE.projectId,
      reason: "store_failed",
    });
    // The original settle error, not anything wrapping it.
    expect(lines[0]!.settleError).toBe(D);
    expect(noteIngestSideEffects).toHaveBeenCalledTimes(0);
  });

  it("T78a: lets an error from before the open through, opening nothing", async () => {
    const X = new Error("boom");
    openUpload.mockRejectedValue(X);

    const thrown = await issueUploadTicket(SCOPE, ITEM, async () => true).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(thrown).toBe(X);
    expect(openSignedUpload).toHaveBeenCalledTimes(0);
    expect(openFailedLines()).toEqual([]);
    expect(noteIngestSideEffects).toHaveBeenCalledTimes(0);
  });

  it("T78b: catches only UploadOpenFailed and lets any other error through", async () => {
    const Y = new Error("not an open failure");
    openSignedUpload.mockRejectedValue(Y);

    const thrown = await issueUploadTicket(SCOPE, ITEM, async () => true).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(thrown).toBe(Y);
    expect(openSignedUpload).toHaveBeenCalledTimes(1);
    expect(openFailedLines()).toEqual([]);
    expect(noteIngestSideEffects).toHaveBeenCalledTimes(0);
  });

  it("T56a: opens nothing on a dedup hit", async () => {
    checkUploadDedup.mockResolvedValue({
      assetId: "asset-1",
      fileUrl: "https://cdn.test.invalid/a.png",
      kind: "image",
      width: 10,
      height: 20,
    });

    const outcome = await issueUploadTicket(SCOPE, ITEM, async () => true);

    expect(outcome).toEqual({
      kind: "alreadyExists",
      assetId: "asset-1",
      fileUrl: "https://cdn.test.invalid/a.png",
      assetKind: "image",
      width: 10,
      height: 20,
    });
    expect(openSignedUpload).toHaveBeenCalledTimes(0);
  });

  it("T56b: opens nothing for a file over the cap", async () => {
    const outcome = await issueUploadTicket(SCOPE, { ...ITEM, size: 2147483649 }, async () => true);

    expect(outcome).toEqual({ kind: "refused", reason: "too_large" });
    expect(openSignedUpload).toHaveBeenCalledTimes(0);
  });

  it("T56c: opens nothing when storage is full", async () => {
    const outcome = await issueUploadTicket(SCOPE, ITEM, async () => false);

    expect(outcome).toEqual({ kind: "refused", reason: "storage" });
    expect(openSignedUpload).toHaveBeenCalledTimes(0);
  });
});

describe("scene model upload provenance", () => {
  it.each([
    ["model/gltf-binary", "model.glb"],
    ["application/zip", "model.zip"],
  ])("records %s as a node-free upload owned by the Project's Studio", async (contentType, filename) => {
    openUpload.mockResolvedValue({ key: K, studioId: SCOPE.studioId, taskId: undefined });
    const admitStorage = vi.fn(async () => true);
    const model = {
      filename, content_type: contentType, size: 4096, client_hash: "a".repeat(64),
      purpose: "scene_model" as const, space_id: SCENE_SPACE, label: "Lamp",
    };

    const outcome = await issueUploadTicket(SCOPE, model, admitStorage);

    expect(outcome).toEqual({
      kind: "ticket", uploadId: OK.uploadId, token: OK.token, storageKey: K,
      uploadUrl: UPLOAD_URL, assetKind: "file", partSize: PART, totalParts: 1, taskId: undefined,
    });
    expect(admitStorage).toHaveBeenCalledTimes(1);
    expect(checkUploadDedup).toHaveBeenCalledWith({ studioId: SCOPE.studioId, contentHash: model.client_hash });
    expect(openUpload).toHaveBeenCalledWith({
      projectId: SCOPE.projectId, actingUserId: SCOPE.userId, declaredSize: model.size,
      taskType: "file", ext: filename.slice(filename.lastIndexOf(".")), expiresAt: expect.any(Date),
      context: {
        nodeId: null, spaceId: SCENE_SPACE, source: null, toolName: null,
        derived: true, filename, assetSource: null,
      },
    }, { budgetMs: 7200000, action: "scene_import", label: "Lamp" }, true);
    expect(openSignedUpload.mock.calls[0]?.[0]).toMatchObject({
      studioId: SCOPE.studioId, userId: SCOPE.userId,
      contentType, declaredSize: model.size,
    });
  });

  it("answers the registered model dedup hit with its done Space row, without opening or consuming storage", async () => {
    const assetId = "55555555-5555-4555-8555-555555555555";
    const fileUrl = "https://assets.example.test/registered-model.glb";
    checkUploadDedup.mockResolvedValue({ assetId, fileUrl, kind: "file", width: null, height: null });
    openDone.mockResolvedValue("scene-task-1");
    const admitStorage = vi.fn(async () => true);
    const model = {
      filename: "model.glb", content_type: "model/gltf-binary", size: 4096,
      client_hash: "a".repeat(64), purpose: "scene_model" as const, space_id: SCENE_SPACE, label: "Lamp",
    };

    expect(await issueUploadTicket(SCOPE, model, admitStorage)).toEqual({
      kind: "alreadyExists", assetId, fileUrl, assetKind: "file", width: null, height: null, taskId: "scene-task-1",
    });
    expect(openDone).toHaveBeenCalledWith({
      projectId: SCOPE.projectId, spaceId: SCENE_SPACE, startedByUserId: SCOPE.userId, label: "Lamp", assetId,
    });
    expect(publishSpaceTasksQuietly).toHaveBeenCalledWith(SCOPE.projectId, SCENE_SPACE);
    expect(admitStorage).not.toHaveBeenCalled();
    expect(openUpload).not.toHaveBeenCalled();
    expect(openSignedUpload).not.toHaveBeenCalled();
    expect(settleDedupHit).toHaveBeenCalledWith({
      projectId: SCOPE.projectId,
      hit: { assetId, fileUrl, kind: "file", width: null, height: null },
      userId: SCOPE.userId,
      metadata: { filename: model.filename, size: model.size, mimeType: model.content_type },
      row: { action: "scene_import", label: "Lamp" }, nodeId: undefined, spaceId: SCENE_SPACE,
    });
  });

  it.each(["project_cover", "studio_avatar"] as const)("preserves the existing %s ledger source", async (purpose) => {
    const image = { filename: "picture.png", content_type: "image/png", size: 4096,
      client_hash: "a".repeat(64), purpose };
    const scope = purpose === "studio_avatar" ? { userId: SCOPE.userId, studioId: SCOPE.studioId } : SCOPE;

    await issueUploadTicket(scope, image, async () => true);

    expect(openUpload.mock.calls[0]?.[0].context).toMatchObject({
      assetSource: purpose, nodeId: null, spaceId: null,
      derived: purpose === "project_cover" ? true : null,
    });
  });
});

